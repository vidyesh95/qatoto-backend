/**
 * Asserts the STORE Phase 17 invariants against a live database.
 *
 *   pnpm run db:verify-store-phase-17-constraints
 *
 * Phase 17 is mostly a PROJECTION — §16's whole argument is that a factory is a read over
 * things Phase 12 already built. A verifier cannot assert a projection, so this file does
 * not try. What it asserts is the part that lives in the database and can rot silently:
 *
 *   * the enum members added by `ALTER TYPE`, which are invisible to `drizzle-kit` once
 *     applied and which four code paths now depend on existing;
 *   * that the CHECK constraints actually REFUSE their illegal pair. Presence in
 *     `pg_constraint` says nothing about the body, and a constraint whose body is wrong
 *     looks identical to one that works — which is the whole reason `probeRefusal` exists;
 *   * that `commerce_organization_site_audit` is present AND carries a NOT NULL
 *     `audit_entry_id`, because an audit with no accountable human behind it is the exact
 *     thing §16.2 built this table to prevent;
 *   * the two keyset indexes, which are the difference between an inquiry list and a
 *     sequential scan.
 *
 * The refusal probes each roll back. Nothing here writes.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";

interface Check {
  readonly name: string;
  readonly why: string;
  run(): Promise<{ readonly ok: boolean; readonly detail: string }>;
}

async function scalar(query: ReturnType<typeof sql>): Promise<number> {
  const result = await db.execute<{ value: number }>(query);
  return result.rows[0]?.value ?? 0;
}

/**
 * Runs a statement and reports whether the database REFUSED it, rolling back either way.
 *
 * A constraint that silently accepts a write it should have rejected is the failure this
 * file exists to catch, and only an attempted write can distinguish that from one that
 * works.
 */
async function probeRefusal(statement: string): Promise<boolean> {
  try {
    await db.transaction(async (transaction) => {
      await transaction.execute(sql.raw(statement));
      throw new Error("verify-probe-rollback");
    });
    return false;
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "verify-probe-rollback") {
      // The statement was ACCEPTED; only our own rollback stopped it.
      return false;
    }
    return true;
  }
}

async function enumHasValue(typeName: string, value: string): Promise<boolean> {
  const found = await scalar(sql`
    SELECT count(*)::int AS value
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = ${typeName} AND e.enumlabel = ${value}`);
  return found === 1;
}

async function tableExists(tableName: string): Promise<boolean> {
  const found = await scalar(sql`
    SELECT count(*)::int AS value
      FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ${tableName}`);
  return found === 1;
}

async function columnIsNotNull(tableName: string, columnName: string): Promise<boolean> {
  const found = await scalar(sql`
    SELECT count(*)::int AS value
      FROM information_schema.columns
     WHERE table_name = ${tableName}
       AND column_name = ${columnName}
       AND is_nullable = 'NO'`);
  return found === 1;
}

async function indexExists(indexName: string): Promise<boolean> {
  const found = await scalar(sql`
    SELECT count(*)::int AS value FROM pg_indexes WHERE indexname = ${indexName}`);
  return found === 1;
}

/**
 * An organization id to hang the refusal probes off. Every probe rolls back, so the row is
 * never actually touched — but a real id is needed to get past the foreign keys and reach
 * the CHECK that is under test.
 */
async function anyOrganizationId(): Promise<string | null> {
  const result = await db.execute<{ id: string }>(sql`SELECT id FROM commerce_organization LIMIT 1`);
  return result.rows[0]?.id ?? null;
}

const CHECKS: readonly Check[] = [
  // -------------------------------------------------------------------------
  // 0099 — the enum widening.
  // -------------------------------------------------------------------------
  ...(
    ["contract_manufacturing", "private_label", "tooling_and_moulds", "assembly"] as const
  ).map((value) => ({
    name: `0099 · commerce_organization_capability_kind carries '${value}'`,
    why: "The directory's capabilityKind filter answers 422 for a value the column cannot hold.",
    async run() {
      const present = await enumHasValue("commerce_organization_capability_kind", value);
      return { ok: present, detail: present ? "present" : "MISSING" };
    },
  })),
  {
    name: "0099 · the Phase 12 capability values SURVIVED the widening",
    why: "ALTER TYPE ADD VALUE is additive; if these are gone the migration was a rewrite and Phase 12's rows are lost.",
    async run() {
      const survivors = await Promise.all(
        (["oem", "odm", "customization", "sample_production"] as const).map((value) =>
          enumHasValue("commerce_organization_capability_kind", value),
        ),
      );
      const missing = survivors.filter((present) => !present).length;
      return { ok: missing === 0, detail: `${String(missing)} of the original four missing` };
    },
  },
  {
    name: "0099 · commerce_thread_resource_kind carries 'manufacturing_inquiry'",
    why: "Without it the send transition cannot open the one-to-one thread and every inquiry is a write into silence.",
    async run() {
      const present = await enumHasValue("commerce_thread_resource_kind", "manufacturing_inquiry");
      return { ok: present, detail: present ? "present" : "MISSING" };
    },
  },
  {
    name: "0099 · platform_audit_event_kind carries both site-audit verdicts",
    why: "site_audited is the strongest claim this platform makes; an unrecordable verdict means an unaccountable one.",
    async run() {
      const [recorded, withdrawn] = await Promise.all([
        enumHasValue("platform_audit_event_kind", "commerce_organization_site_audit_recorded"),
        enumHasValue("platform_audit_event_kind", "commerce_organization_site_audit_withdrawn"),
      ]);
      return {
        ok: recorded && withdrawn,
        detail: `recorded=${String(recorded)} withdrawn=${String(withdrawn)}`,
      };
    },
  },

  // -------------------------------------------------------------------------
  // 0100 — the factory directory's own rows.
  // -------------------------------------------------------------------------
  ...(
    [
      "commerce_organization_production_line",
      "commerce_organization_site",
      "commerce_organization_site_audit",
      "commerce_organization_site_audit_site",
    ] as const
  ).map((tableName) => ({
    name: `0100 · ${tableName} exists`,
    why: "The directory read joins it; a missing table is a 500 on every factory detail.",
    async run() {
      const present = await tableExists(tableName);
      return { ok: present, detail: present ? "present" : "MISSING" };
    },
  })),
  {
    name: "0100 · a production line CANNOT be stored without a unit label",
    why: "A monthly capacity with no unit cannot be compared against an order, which makes the number worse than absent.",
    async run() {
      const notNull = await columnIsNotNull("commerce_organization_production_line", "unit_label");
      return { ok: notNull, detail: notNull ? "unit_label is NOT NULL" : "unit_label is NULLABLE" };
    },
  },
  {
    name: "0100 · a site audit CANNOT be stored without an audit entry",
    why: "An audit with no accountable human behind it is exactly what §16.2 built this table to prevent.",
    async run() {
      const notNull = await columnIsNotNull("commerce_organization_site_audit", "audit_entry_id");
      return {
        ok: notNull,
        detail: notNull ? "audit_entry_id is NOT NULL" : "audit_entry_id is NULLABLE",
      };
    },
  },
  {
    name: "0100 · commerce_organization_certification.standard_code is NULLABLE",
    why: "The vocabulary is the world's; a NOT NULL code would refuse every standard outside the eight.",
    async run() {
      const notNull = await columnIsNotNull(
        "commerce_organization_certification",
        "standard_code",
      );
      return { ok: !notNull, detail: notNull ? "NOT NULL — wrong" : "nullable" };
    },
  },
  {
    name: "0100 · the seller profile REFUSES half a MOQ pair",
    why: "A bare 500 is unreadable: 500 pieces and 500 cartons are different businesses.",
    async run() {
      const organizationId = await anyOrganizationId();
      if (!organizationId) {
        return { ok: false, detail: "no commerce_organization rows — constraint UNEXERCISED" };
      }
      const refused = await probeRefusal(`
        INSERT INTO commerce_seller_profile (organization_id, minimum_order_quantity)
        VALUES ('${organizationId}', 500)
        ON CONFLICT (organization_id) DO UPDATE
          SET minimum_order_quantity = 500, minimum_order_quantity_unit_label = NULL`);
      return {
        ok: refused,
        detail: refused ? "refused" : "ACCEPTED a quantity with no unit label",
      };
    },
  },
  {
    name: "0100 · the seller profile REFUSES an inverted lead-time range",
    why: "A maximum shorter than its minimum renders as a range no buyer can act on.",
    async run() {
      const organizationId = await anyOrganizationId();
      if (!organizationId) {
        return { ok: false, detail: "no commerce_organization rows — constraint UNEXERCISED" };
      }
      const refused = await probeRefusal(`
        INSERT INTO commerce_seller_profile
          (organization_id, minimum_lead_time_days, maximum_lead_time_days)
        VALUES ('${organizationId}', 60, 30)
        ON CONFLICT (organization_id) DO UPDATE
          SET minimum_lead_time_days = 60, maximum_lead_time_days = 30`);
      return { ok: refused, detail: refused ? "refused" : "ACCEPTED max < min" };
    },
  },
  {
    name: "0100 · the seller profile REFUSES a sample fee with samples switched off",
    why: "A fee on a profile that offers no samples is a contradiction the read would have to pick a winner for.",
    async run() {
      const organizationId = await anyOrganizationId();
      if (!organizationId) {
        return { ok: false, detail: "no commerce_organization rows — constraint UNEXERCISED" };
      }
      const refused = await probeRefusal(`
        INSERT INTO commerce_seller_profile
          (organization_id, offers_samples, sample_fee_in_cents)
        VALUES ('${organizationId}', false, 5000)
        ON CONFLICT (organization_id) DO UPDATE
          SET offers_samples = false, sample_fee_in_cents = 5000`);
      return { ok: refused, detail: refused ? "refused" : "ACCEPTED a fee with no sample offer" };
    },
  },
  {
    name: "0100 · sample_fee_in_cents is NULLABLE, because unstated is not free",
    why: "Rendering an unstated fee as free is the one thing this surface must never do.",
    async run() {
      const notNull = await columnIsNotNull("commerce_seller_profile", "sample_fee_in_cents");
      return { ok: !notNull, detail: notNull ? "NOT NULL — wrong" : "nullable" };
    },
  },

  // -------------------------------------------------------------------------
  // 0101 — the manufacturing inquiry.
  // -------------------------------------------------------------------------
  {
    name: "0101 · commerce_manufacturing_inquiry exists with a NOT NULL capability_kind",
    why: "capabilityKind is the field that decides whether the inquiry is answerable at all.",
    async run() {
      const [present, notNull] = await Promise.all([
        tableExists("commerce_manufacturing_inquiry"),
        columnIsNotNull("commerce_manufacturing_inquiry", "capability_kind"),
      ]);
      return {
        ok: present && notNull,
        detail: `table=${String(present)} capability_kind NOT NULL=${String(notNull)}`,
      };
    },
  },
  {
    name: "0101 · both keyset indexes exist",
    why: "Without them /mine and /received are a sequential scan of every inquiry in the system.",
    async run() {
      const [buyer, factory] = await Promise.all([
        indexExists("commerce_manufacturing_inquiry_buyer_idx"),
        indexExists("commerce_manufacturing_inquiry_factory_idx"),
      ]);
      return { ok: buyer && factory, detail: `buyer=${String(buyer)} factory=${String(factory)}` };
    },
  },
  {
    name: "0101 · the reference is unique",
    why: "A reference two buyers can both read out on a call identifies nothing.",
    async run() {
      const present = await indexExists("commerce_manufacturing_inquiry_reference_uidx");
      return { ok: present, detail: present ? "present" : "MISSING" };
    },
  },
];

async function main(): Promise<void> {
  console.log("verify-store-phase-17-constraints\n");
  let failures = 0;

  for (const check of CHECKS) {
    const result = await check.run();
    console.log(`${result.ok ? "  ok  " : "  FAIL"}  ${check.name} — ${result.detail}`);
    if (!result.ok) {
      console.log(`        why it matters: ${check.why}`);
      failures += 1;
    }
  }

  console.log(`\n${String(CHECKS.length - failures)}/${String(CHECKS.length)} checks passed.`);
  if (failures > 0) process.exitCode = 1;
}

await main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
