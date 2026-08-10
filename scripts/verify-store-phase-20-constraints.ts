/**
 * Asserts the STORE Phase 20 invariants against a live database.
 *
 *   pnpm run db:verify-store-phase-20-constraints
 *
 * WHAT THIS FILE IS REALLY GUARDING is one sentence from §19.6: partial data yields a partial
 * answer, never an extrapolated whole one. Most of these CHECKs exist so that a number nobody
 * published cannot be STORED — a zero unit price, a zero-day customs clearance on a domestic
 * lane, two bands sharing a floor. If a constraint stops refusing, the rating read starts
 * publishing something a forwarder never sold, and nothing downstream would notice.
 *
 * The migration and the Drizzle schema are BOTH hand-written (house rule since 0046), so this
 * is also where the two are checked against each other on a real database rather than by eye.
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

async function probeRefusal(statement: string): Promise<boolean> {
  try {
    await db.transaction(async (transaction) => {
      await transaction.execute(sql.raw(statement));
      throw new Error("verify-probe-rollback");
    });
    return false;
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "verify-probe-rollback") {
      return false;
    }
    return true;
  }
}

async function tableExists(tableName: string): Promise<boolean> {
  const found = await scalar(sql`
    SELECT count(*)::int AS value
      FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ${tableName}`);
  return found === 1;
}

async function indexExists(indexName: string): Promise<boolean> {
  const found = await scalar(sql`
    SELECT count(*)::int AS value FROM pg_indexes WHERE indexname = ${indexName}`);
  return found === 1;
}

async function columnExists(tableName: string, columnName: string): Promise<boolean> {
  const found = await scalar(sql`
    SELECT count(*)::int AS value
      FROM information_schema.columns
     WHERE table_name = ${tableName} AND column_name = ${columnName}`);
  return found === 1;
}

/**
 * A rate card that the probes below can hang a band off. Every probe runs inside a
 * transaction that is rolled back, so this is only ever a statement fragment.
 */
const PROBE_CARD_INSERT = `
  INSERT INTO commerce_freight_rate_card
    (id, provider_organization_id, origin_country_code, destination_country_code, mode,
     currency, valid_from, source_forwarder_name, volumetric_divisor_cm3_per_kg)
  SELECT 'probe_rate_card', organization_id, 'IN', 'DE', 'sea', 'USD', now(), 'Probe Forwarder', 1000
    FROM commerce_provider_profile LIMIT 1`;

const CHECKS: readonly Check[] = [
  {
    name: "§19.2 · the three Phase 20 tables exist",
    why: "The whole phase is these tables. Absent, every rating read silently reports an uncovered lane.",
    async run() {
      const present = await Promise.all(
        [
          "commerce_freight_rate_card",
          "commerce_freight_rate_break",
          "commerce_customs_dwell_estimate",
        ].map(tableExists),
      );
      const missing = present.filter((exists) => !exists).length;
      return { ok: missing === 0, detail: `${String(3 - missing)}/3 tables present` };
    },
  },
  {
    name: "§19.2 · NO second enum duplicates the shipment leg modes",
    why: "commerce_shipment_leg_mode already carries air|sea|land|rail. A parallel enum with the same members is how a card becomes unmatchable to the shipment it priced.",
    async run() {
      /**
       * MATCHED ON THE MEMBER SET, NOT ON THE NAME. A name pattern flags
       * `freight_transport_mode`, which is the pre-existing OFFERING-level enum — it carries
       * `multimodal` as a fifth member and is a different thing legitimately. The invariant is
       * "no second type carries exactly these four", and that is what is asked here.
       */
      const duplicates = await scalar(sql`
        SELECT count(*)::int AS value FROM (
          SELECT t.typname
            FROM pg_type t
            JOIN pg_enum e ON e.enumtypid = t.oid
           WHERE t.typname <> 'commerce_shipment_leg_mode'
           GROUP BY t.typname
          HAVING array_agg(e.enumlabel::text ORDER BY e.enumlabel::text)
                 = ARRAY['air','land','rail','sea']
        ) AS duplicated_mode_enums`);
      return { ok: duplicates === 0, detail: `${String(duplicates)} duplicate mode enum(s)` };
    },
  },
  {
    name: "§19.2 · the rate card's mode column IS the shipment leg enum",
    why: "The read half matches a card to the leg it priced by this type. A divergence is invisible until a shipment cannot be reconciled.",
    async run() {
      const matched = await scalar(sql`
        SELECT count(*)::int AS value
          FROM information_schema.columns
         WHERE table_name = 'commerce_freight_rate_card'
           AND column_name = 'mode'
           AND udt_name = 'commerce_shipment_leg_mode'`);
      return { ok: matched === 1, detail: matched === 1 ? "shared enum" : "NOT the shared enum" };
    },
  },
  {
    name: "§19.6 · a zero unit price is refused",
    why: "\"An uncovered lane returns an empty options[], never a zero.\" A zero-priced band would publish free freight.",
    async run() {
      const refused = await probeRefusal(`
        ${PROBE_CARD_INSERT};
        INSERT INTO commerce_freight_rate_break
          (id, rate_card_id, position, min_billable_weight_grams, min_volume_cubic_cm,
           unit_price_in_cents, minimum_charge_in_cents, transit_days_min, transit_days_max)
        VALUES ('probe_break', 'probe_rate_card', 0, 0, 0, 0, 0, 24, 34)`);
      return { ok: refused, detail: refused ? "refused" : "ACCEPTED a zero unit price" };
    },
  },
  {
    name: "§19.2 · two bands on one card may not share a floor",
    why: "The ladder picks the highest band a consignment clears. Two rows with one floor make that pick arbitrary, and an arbitrary pick is a price the platform cannot explain.",
    async run() {
      const refused = await probeRefusal(`
        ${PROBE_CARD_INSERT};
        INSERT INTO commerce_freight_rate_break
          (id, rate_card_id, position, min_billable_weight_grams, min_volume_cubic_cm,
           unit_price_in_cents, minimum_charge_in_cents, transit_days_min, transit_days_max)
        VALUES ('probe_break_a', 'probe_rate_card', 0, 45000, 0, 400, 0, 24, 34),
               ('probe_break_b', 'probe_rate_card', 1, 45000, 0, 500, 0, 20, 30)`);
      return { ok: refused, detail: refused ? "refused" : "ACCEPTED a duplicated floor" };
    },
  },
  {
    name: "§19.2 · transit days may not run backwards",
    why: "A band whose maximum precedes its minimum produces a range the arrival window would then sum.",
    async run() {
      const refused = await probeRefusal(`
        ${PROBE_CARD_INSERT};
        INSERT INTO commerce_freight_rate_break
          (id, rate_card_id, position, min_billable_weight_grams, min_volume_cubic_cm,
           unit_price_in_cents, minimum_charge_in_cents, transit_days_min, transit_days_max)
        VALUES ('probe_break', 'probe_rate_card', 0, 0, 0, 400, 0, 34, 24)`);
      return { ok: refused, detail: refused ? "refused" : "ACCEPTED an inverted transit range" };
    },
  },
  {
    name: "§19.3 · a DOMESTIC customs dwell row is refused",
    why: "A domestic lane has no customs leg — an ABSENT component, not a zero-day one. A stored IN→IN row would make \"not applicable\" recordable as \"known to be short\", which is the A11 mistake in a new place.",
    async run() {
      const refused = await probeRefusal(`
        INSERT INTO commerce_customs_dwell_estimate
          (id, destination_country_code, origin_country_code, clearance_days_min,
           clearance_days_max, source, valid_from)
        VALUES ('probe_dwell', 'IN', 'IN', 0, 0, 'Probe', now())`);
      return { ok: refused, detail: refused ? "refused" : "ACCEPTED a domestic dwell row" };
    },
  },
  {
    name: "§19.3 · at most one OPEN-ENDED dwell estimate per scope",
    why: "Two rows both claiming \"any origin into DE, indefinitely\" make the resolver's answer arbitrary.",
    async run() {
      const refused = await probeRefusal(`
        INSERT INTO commerce_customs_dwell_estimate
          (id, destination_country_code, origin_country_code, clearance_days_min,
           clearance_days_max, source, valid_from)
        VALUES ('probe_dwell_a', 'DE', NULL, 3, 10, 'Probe A', now()),
               ('probe_dwell_b', 'DE', NULL, 4, 12, 'Probe B', now())`);
      return { ok: refused, detail: refused ? "refused" : "ACCEPTED two live any-origin rows" };
    },
  },
  {
    name: "§19.2 · a card may not supersede itself",
    why: "The lifecycle cannot be half-true. A self-referencing successor is a cycle the read half would follow forever.",
    async run() {
      const refused = await probeRefusal(`
        ${PROBE_CARD_INSERT};
        UPDATE commerce_freight_rate_card
           SET state = 'superseded', superseded_by_rate_card_id = 'probe_rate_card'
         WHERE id = 'probe_rate_card'`);
      return { ok: refused, detail: refused ? "refused" : "ACCEPTED a self-supersession" };
    },
  },
  {
    name: "§19.2 · the write-side one-active-card-per-lane index exists",
    why: "It is what makes supersede-and-mint safe under concurrency. Without it two creates on one lane both land.",
    async run() {
      const present = await indexExists("commerce_freight_rate_card_active_uidx");
      return { ok: present, detail: present ? "present" : "MISSING" };
    },
  },
  {
    name: "§19.9 · the volumetric divisor column exists and is NOT NULL",
    why: "Without it, rating falls back to actual weight and a light bulky consignment is underpriced — the one Phase 20 defect that produced a wrong number rather than a missing one.",
    async run() {
      const nullable = await scalar(sql`
        SELECT count(*)::int AS value
          FROM information_schema.columns
         WHERE table_name = 'commerce_freight_rate_card'
           AND column_name = 'volumetric_divisor_cm3_per_kg'
           AND is_nullable = 'NO'`);
      return { ok: nullable === 1, detail: nullable === 1 ? "present, NOT NULL" : "MISSING or nullable" };
    },
  },
  {
    name: "§19.9 · a card with NO volumetric divisor is refused",
    why: "A missing divisor would have to be defaulted, and defaulting one is the platform choosing a tariff convention on a forwarder's behalf.",
    async run() {
      const refused = await probeRefusal(`
        INSERT INTO commerce_freight_rate_card
          (id, provider_organization_id, origin_country_code, destination_country_code, mode,
           currency, valid_from, source_forwarder_name)
        SELECT 'probe_no_divisor', organization_id, 'IN', 'DE', 'sea', 'USD', now(), 'Probe'
          FROM commerce_provider_profile LIMIT 1`);
      return { ok: refused, detail: refused ? "refused" : "ACCEPTED a card with no divisor" };
    },
  },
  {
    name: "§19.9 · an out-of-range volumetric divisor is refused",
    why: "A transposed figure — 100000 for 1000 — would underprice by two orders of magnitude and look plausible in a form.",
    async run() {
      const refused = await probeRefusal(`
        INSERT INTO commerce_freight_rate_card
          (id, provider_organization_id, origin_country_code, destination_country_code, mode,
           currency, valid_from, source_forwarder_name, volumetric_divisor_cm3_per_kg)
        SELECT 'probe_bad_divisor', organization_id, 'IN', 'DE', 'sea', 'USD', now(), 'Probe', 0
          FROM commerce_provider_profile LIMIT 1`);
      return { ok: refused, detail: refused ? "refused" : "ACCEPTED a zero divisor" };
    },
  },
  {
    name: "§19.4 · the lead-time minimum snapshot columns exist",
    why: "Manufacturing is reported as a range. Without these the range has no floor and every order reports daysMin null forever.",
    async run() {
      const present = await Promise.all([
        columnExists("commerce_checkout_prepare_product_line", "lead_time_min_days_snapshot"),
        columnExists("commerce_order_product_line", "lead_time_min_days_snapshot"),
      ]);
      const missing = present.filter((exists) => !exists).length;
      return { ok: missing === 0, detail: `${String(2 - missing)}/2 columns present` };
    },
  },
  {
    name: "§19.4 · a snapshotted lead-time minimum may not exceed its maximum",
    why: "A prepare line reporting \"25 to 15 days\" would make the arrival window run backwards.",
    async run() {
      const refused = await probeRefusal(`
        UPDATE commerce_checkout_prepare_product_line
           SET lead_time_min_days_snapshot = 40, lead_time_max_days_snapshot = 10`);
      const anyRows = await scalar(sql`
        SELECT count(*)::int AS value FROM commerce_checkout_prepare_product_line`);
      return {
        ok: refused || anyRows === 0,
        detail: anyRows === 0 ? "no rows to probe (vacuously ok)" : refused ? "refused" : "ACCEPTED an inverted range",
      };
    },
  },
  {
    name: "live · every superseded card names its successor",
    why: "The live-data reading of the lifecycle CHECK: a violation means something bypassed it.",
    async run() {
      const leaked = await scalar(sql`
        SELECT count(*)::int AS value
          FROM commerce_freight_rate_card
         WHERE (state = 'superseded') <> (superseded_by_rate_card_id IS NOT NULL)`);
      return { ok: leaked === 0, detail: `${String(leaked)} card(s) in an impossible state` };
    },
  },
  {
    name: "live · no rate card is in force with no bands",
    why: "A card with no bands prices nothing, so the lane reads as uncovered — indistinguishable from a lane that genuinely is. This is the one defect the schema cannot refuse, so it is checked here.",
    async run() {
      const bandless = await scalar(sql`
        SELECT count(*)::int AS value
          FROM commerce_freight_rate_card card
         WHERE card.state <> 'withdrawn'
           AND card.valid_from <= now()
           AND (card.valid_until IS NULL OR card.valid_until > now())
           AND NOT EXISTS (
                 SELECT 1 FROM commerce_freight_rate_break band
                  WHERE band.rate_card_id = card.id)`);
      return { ok: bandless === 0, detail: `${String(bandless)} live card(s) with no bands` };
    },
  },
];

async function main(): Promise<void> {
  console.log("verify-store-phase-20-constraints\n");
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
