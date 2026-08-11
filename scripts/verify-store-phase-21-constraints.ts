/**
 * Asserts the STORE Phase 21 invariants against a live database.
 *
 *   pnpm run db:verify-store-phase-21-constraints
 *
 * WHAT THIS FILE IS REALLY GUARDING is the bargain Appendix A37 struck: `country_code` became
 * nullable so the server would not have to invent a fact it does not have, and the ONLY thing
 * keeping that from becoming a hole in every public projection is
 * `commerce_organization_country_pending_ck`. Fifteen read paths now assume a trading
 * organization has a country. If that CHECK stops refusing, they do not start returning null —
 * they start THROWING, in production, on a storefront.
 *
 * The second half is the concurrency guard. `commerce_organization_auto_provisioned_owner_uidx`
 * is what makes two simultaneous first taps produce one cart instead of two organizations, and
 * a partial index is easy to recreate without its predicate.
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

async function indexExists(indexName: string): Promise<boolean> {
  const found = await scalar(sql`
    SELECT count(*)::int AS value FROM pg_indexes WHERE indexname = ${indexName}`);
  return found === 1;
}

async function columnIsNullable(tableName: string, columnName: string): Promise<boolean> {
  const nullable = await scalar(sql`
    SELECT count(*)::int AS value
      FROM information_schema.columns
     WHERE table_name = ${tableName}
       AND column_name = ${columnName}
       AND is_nullable = 'YES'`);
  return nullable === 1;
}

/**
 * A user the probes can own an organization as. Every probe runs inside a transaction that is
 * rolled back, so this only ever selects an existing row.
 */
const PROBE_SHELL_INSERT = `
  INSERT INTO commerce_organization
    (id, slug, legal_name, normalized_legal_name, display_name, organization_type,
     trade_state, visibility, country_code, provisioning_origin, created_by_user_id)
  SELECT 'probe-org-a', 'probe-org-a', 'Probe A', 'probe a', 'Probe A', 'sole_proprietor',
         'pending', 'private', NULL, 'auto_provisioned', id
    FROM "user" LIMIT 1`;

const CHECKS: readonly Check[] = [
  {
    name: "A37 · commerce_organization.country_code is nullable",
    why: "Auto-provisioning writes NULL. If the column is NOT NULL again, every first cart tap 500s at the INSERT.",
    async run() {
      const nullable = await columnIsNullable("commerce_organization", "country_code");
      return { ok: nullable, detail: nullable ? "nullable" : "NOT NULL — 0111 was reverted" };
    },
  },
  {
    name: "A37 · provisioning_origin exists and defaults to self_declared",
    why: "The default is what keeps every pre-Phase-21 row meaning what it meant. A wrong default relabels every existing organization as a server-minted shell.",
    async run() {
      const correct = await scalar(sql`
        SELECT count(*)::int AS value
          FROM information_schema.columns
         WHERE table_name = 'commerce_organization'
           AND column_name = 'provisioning_origin'
           AND is_nullable = 'NO'
           AND column_default LIKE '%self_declared%'`);
      return {
        ok: correct === 1,
        detail: correct === 1 ? "present, NOT NULL, correct default" : "missing or wrong default",
      };
    },
  },
  {
    name: "A37 · an ACTIVE organization with no country is refused",
    why: "THE LOAD-BEARING CHECK. Fifteen public projections assume a trading organization has a country and `tradingOrganizationCountryCode` throws when one does not. Without this constraint that throw becomes a production 500 on a storefront.",
    async run() {
      const refused = await probeRefusal(`
        ${PROBE_SHELL_INSERT};
        UPDATE commerce_organization SET trade_state = 'active' WHERE id = 'probe-org-a'`);
      return {
        ok: refused,
        detail: refused ? "refused" : "ACCEPTED — country_pending_ck is missing",
      };
    },
  },
  {
    name: "A37 · a PENDING organization with no country is accepted",
    why: "The other half of the same rule. If this is refused, auto-provisioning cannot mint anything and the buyer surface is back to 403.",
    async run() {
      const refused = await probeRefusal(PROBE_SHELL_INSERT);
      return {
        ok: !refused,
        detail: refused ? "REFUSED — the shell cannot be minted" : "accepted",
      };
    },
  },
  {
    name: "A37 · a malformed country code is still refused",
    why: "Relaxing NOT NULL must not have relaxed the format. `country_code IS NULL OR ~ '^[A-Z]{2}$'` — a lowercase or three-letter code would reach a tax or compliance read that expects ISO-3166 alpha-2.",
    async run() {
      const refused = await probeRefusal(`
        ${PROBE_SHELL_INSERT};
        UPDATE commerce_organization SET country_code = 'india' WHERE id = 'probe-org-a'`);
      return { ok: refused, detail: refused ? "refused" : "ACCEPTED — the format check was lost" };
    },
  },
  {
    name: "A37 · a second auto-provisioned shell for one user is refused",
    why: "The concurrency guard. Two simultaneous first taps both find no membership and both try to mint; without this index the loser creates a second organization and the buyer ends up with two carts.",
    async run() {
      const refused = await probeRefusal(`
        ${PROBE_SHELL_INSERT};
        INSERT INTO commerce_organization
          (id, slug, legal_name, normalized_legal_name, display_name, organization_type,
           trade_state, visibility, country_code, provisioning_origin, created_by_user_id)
        SELECT 'probe-org-b', 'probe-org-b', 'Probe B', 'probe b', 'Probe B', 'sole_proprietor',
               'pending', 'private', NULL, 'auto_provisioned', created_by_user_id
          FROM commerce_organization WHERE id = 'probe-org-a'`);
      return {
        ok: refused,
        detail: refused ? "refused" : "ACCEPTED — the partial unique index is missing",
      };
    },
  },
  {
    name: "A37 · a SELF-DECLARED second organization for one user is accepted",
    why: "The index must stay PARTIAL. Made total, it would stop anybody from creating a second real organization — a rule nobody agreed to, enforced by an index that was only ever meant to close a race.",
    async run() {
      const refused = await probeRefusal(`
        ${PROBE_SHELL_INSERT};
        INSERT INTO commerce_organization
          (id, slug, legal_name, normalized_legal_name, display_name, organization_type,
           trade_state, visibility, country_code, provisioning_origin, created_by_user_id)
        SELECT 'probe-org-c', 'probe-org-c', 'Probe C', 'probe c', 'Probe C', 'company',
               'pending', 'private', 'IN', 'self_declared', created_by_user_id
          FROM commerce_organization WHERE id = 'probe-org-a'`);
      return {
        ok: !refused,
        detail: refused ? "REFUSED — the index lost its predicate" : "accepted",
      };
    },
  },
  {
    name: "A37 · store_search_document.organization_country_code is nullable",
    why: "A document is written for every organization, eligible or not. A NOT NULL column here makes `refreshOrganizationSearchDocument` throw the first time a shell is renamed.",
    async run() {
      const nullable = await columnIsNullable("store_search_document", "organization_country_code");
      return {
        ok: nullable,
        detail: nullable ? "nullable" : "NOT NULL — the mirror half of 0111 was reverted",
      };
    },
  },
  {
    name: "A37 · an ELIGIBLE search document with no country is refused",
    why: "An ineligible row with no country is invisible; an eligible one is a hole in the facet counts that nothing reports. The organization-side CHECK already makes it unreachable — this is the restatement that survives a writer bypassing the refresh path.",
    async run() {
      const refused = await probeRefusal(`
        UPDATE store_search_document
           SET organization_country_code = NULL, is_eligible = true
         WHERE id = (SELECT id FROM store_search_document LIMIT 1)`);
      const anyDocuments = await scalar(sql`
        SELECT count(*)::int AS value FROM store_search_document LIMIT 1`);
      if (anyDocuments === 0) {
        return { ok: true, detail: "skipped — no search documents to probe" };
      }
      return {
        ok: refused,
        detail: refused ? "refused" : "ACCEPTED — eligible_country_ck is missing",
      };
    },
  },
  {
    name: "live · no trading organization is missing a country",
    why: "The CHECK covers rows written after 0111. This covers the data as it actually stands, which is what the read paths will meet.",
    async run() {
      const missing = await scalar(sql`
        SELECT count(*)::int AS value
          FROM commerce_organization
         WHERE trade_state <> 'pending' AND country_code IS NULL`);
      return {
        ok: missing === 0,
        detail: `${String(missing)} non-pending organization(s) with no country`,
      };
    },
  },
  {
    name: "live · no eligible search document is missing a country",
    why: "Same reasoning, one table over. An eligible document with no country would undercount every facet it belongs to, silently.",
    async run() {
      const missing = await scalar(sql`
        SELECT count(*)::int AS value
          FROM store_search_document
         WHERE is_eligible = true AND organization_country_code IS NULL`);
      return {
        ok: missing === 0,
        detail: `${String(missing)} eligible document(s) with no country`,
      };
    },
  },
  {
    name: "live · no user holds two auto-provisioned shells",
    why: "The index refuses new duplicates; this catches any that predate it or arrived while it was absent. Two shells means two carts and a buyer who cannot find what they added.",
    async run() {
      const duplicated = await scalar(sql`
        SELECT count(*)::int AS value FROM (
          SELECT created_by_user_id
            FROM commerce_organization
           WHERE provisioning_origin = 'auto_provisioned'
           GROUP BY created_by_user_id
          HAVING count(*) > 1
        ) AS duplicates`);
      return {
        ok: duplicated === 0,
        detail: `${String(duplicated)} user(s) with more than one shell`,
      };
    },
  },
  {
    name: "A37 · the owner index exists by name",
    why: "The refusal probes prove SOMETHING refused. This proves it was the index 0111 created, rather than an unrelated constraint that happens to fire on the same statement.",
    async run() {
      const present = await indexExists("commerce_organization_auto_provisioned_owner_uidx");
      return { ok: present, detail: present ? "present" : "missing" };
    },
  },
];

async function main(): Promise<void> {
  console.log("verify-store-phase-21-constraints\n");
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
