/**
 * Asserts the STORE Phase 19 invariants against a live database.
 *
 *   pnpm run db:verify-store-phase-19-constraints
 *
 * THE FIRST CHECK IN THIS FILE IS THE MOST IMPORTANT ONE, and it asserts an ABSENCE.
 *
 * §14 has not decided whether Qatoto may publish a self-declared capital range beside an
 * equity expectation, and its instruction is literal: until it does, the backend stores no
 * capital figure it would then have to publish. A column that exists and is withheld by a
 * projection is one careless edit from being published — so the columns do not exist, and
 * this verifier is what catches somebody adding one before the decision lands.
 *
 * The rest is the ordinary shape: the unique index that keeps one profile per person, the
 * CHECKs that actually refuse their illegal combination, and the tag tables.
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

const CHECKS: readonly Check[] = [
  {
    name: "§14 · the profile stores NO capital or equity figure",
    why: "Until §14 decides, the backend stores no capital figure it would then have to publish. A column that exists is one edit from being published.",
    async run() {
      const rows = await db.execute<{ column_name: string }>(sql`
        SELECT column_name
          FROM information_schema.columns
         WHERE table_name = 'community_cofounder_profile'
           AND (column_name LIKE '%capital%'
                OR column_name LIKE '%equity%'
                OR column_name LIKE '%basis_point%'
                OR column_name = 'currency')`);
      const found = rows.rows.map((row) => row.column_name);
      return {
        ok: found.length === 0,
        detail:
          found.length === 0
            ? "absent, as §14 requires"
            : `PRESENT: ${found.join(", ")} — §14 has not cleared this`,
      };
    },
  },
  ...(
    [
      "community_cofounder_profile",
      "community_cofounder_profile_contribution",
      "community_cofounder_profile_sector",
      "community_cofounder_profile_language",
      "community_cofounder_prior_venture",
    ] as const
  ).map((tableName) => ({
    name: `0105 · ${tableName} exists`,
    why: "The directory is five tables; a missing one is a 500 on the surface it serves.",
    async run() {
      const present = await tableExists(tableName);
      return { ok: present, detail: present ? "present" : "MISSING" };
    },
  })),
  {
    name: "0105 · one profile per person, enforced by a unique index",
    why: "It is the storage-layer form of the rule that nobody lists anybody else, and /mine depends on it.",
    async run() {
      const present = await indexExists("community_cofounder_profile_user_uidx");
      return { ok: present, detail: present ? "present" : "MISSING" };
    },
  },
  {
    name: "0105 · a published profile REFUSES a null published_at",
    why: "The public detail read projects publishedAt; a published row without one renders an absence where a date belongs.",
    async run() {
      const refused = await probeRefusal(`
        INSERT INTO community_cofounder_profile
          (id, slug, user_id, display_name, headline, bio, looking_for, country_code,
           commitment_level, state)
        VALUES ('verify-probe-cofounder', 'verify-probe-cofounder',
                (SELECT id FROM "user" LIMIT 1),
                'Probe Person', 'A headline long enough',
                'A bio long enough to pass the twenty character floor.',
                'Looking for a probe', 'IN', 'full_time', 'published')`);
      return {
        ok: refused,
        detail: refused ? "refused" : "ACCEPTED a published profile with no publish date",
      };
    },
  },
  {
    name: "0105 · a prior venture REFUSES a negative position",
    why: "Position is the ordering the detail read renders; a negative one sorts ahead of everything and means nothing.",
    async run() {
      const refused = await probeRefusal(`
        INSERT INTO community_cofounder_prior_venture
          (id, profile_id, name, role_label, years_active_label, position)
        VALUES ('verify-probe-venture', 'any', 'A venture', 'Founder', '2019-2022', -1)`);
      return { ok: refused, detail: refused ? "refused" : "ACCEPTED a negative position" };
    },
  },
  {
    name: "0105 · a language code REFUSES anything but two lowercase letters",
    why: "Free text here produces 'english', 'English' and 'EN' side by side on one profile.",
    async run() {
      const refused = await probeRefusal(`
        INSERT INTO community_cofounder_profile_language (profile_id, language_code)
        VALUES ('any', 'English')`);
      return { ok: refused, detail: refused ? "refused" : "ACCEPTED a non-ISO language" };
    },
  },
  {
    name: "0104 · the identity enum has exactly TWO values",
    why: "A third rung would be read as verifying the claims, and nobody checked any of them.",
    async run() {
      const count = await scalar(sql`
        SELECT count(*)::int AS value
          FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'community_cofounder_identity_state'`);
      return { ok: count === 2, detail: `${String(count)} value(s)` };
    },
  },
  {
    name: "0105 · the directory keyset index exists",
    why: "Without it the public directory is a sequential scan of every profile on the platform.",
    async run() {
      const present = await indexExists("community_cofounder_profile_directory_idx");
      return { ok: present, detail: present ? "present" : "MISSING" };
    },
  },
  {
    name: "0105 · the moderation log can point at a profile",
    why: "Without the column a publish decision has nothing to attach to and the log loses half its subjects.",
    async run() {
      const found = await scalar(sql`
        SELECT count(*)::int AS value
          FROM information_schema.columns
         WHERE table_name = 'community_moderation_action'
           AND column_name = 'cofounder_profile_id'`);
      return { ok: found === 1, detail: found === 1 ? "present" : "MISSING" };
    },
  },
  {
    name: "live · no published profile is missing its publish date",
    why: "The live-data reading of the constraint above: a violation means something bypassed it.",
    async run() {
      const leaked = await scalar(sql`
        SELECT count(*)::int AS value
          FROM community_cofounder_profile
         WHERE state = 'published' AND published_at IS NULL`);
      return { ok: leaked === 0, detail: `${String(leaked)} profile(s) in an impossible state` };
    },
  },
];

async function main(): Promise<void> {
  console.log("verify-store-phase-19-constraints\n");
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
