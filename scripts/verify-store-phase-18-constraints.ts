/**
 * Asserts the STORE Phase 18 invariants against a live database.
 *
 *   pnpm run db:verify-store-phase-18-constraints
 *
 * The forum's load-bearing rules are mostly SERVICE rules — a projection, a state gate, a
 * moderation queue predicate — and a verifier cannot assert those. What it asserts is the
 * part that lives in the database and can rot silently:
 *
 *   * that the vote table is keyed on the USER rather than an organization, because that is
 *     the one place this table departs from its commerce sibling and a "fix" back to the
 *     organization would exclude every individual poster;
 *   * that the CHECK constraints REFUSE their illegal combination. Presence in
 *     `pg_constraint` says nothing about the body;
 *   * that `community_moderation_action.audit_entry_id` is NOT NULL, because a decision
 *     with no accountable human behind it is what the platform chain exists to prevent;
 *   * that no thread is publicly readable while it is still `pending_review` — the rule
 *     that keeps A10 closed while a public text surface exists at all.
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

async function enumHasValue(typeName: string, value: string): Promise<boolean> {
  const found = await scalar(sql`
    SELECT count(*)::int AS value
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = ${typeName} AND e.enumlabel = ${value}`);
  return found === 1;
}

const CHECKS: readonly Check[] = [
  ...(
    [
      "community_forum_thread",
      "community_forum_reply",
      "community_forum_reply_vote",
      "community_content_report",
      "community_moderation_action",
    ] as const
  ).map((tableName) => ({
    name: `0103 · ${tableName} exists`,
    why: "The forum is five tables; a missing one is a 500 on the surface it serves.",
    async run() {
      const present = await tableExists(tableName);
      return { ok: present, detail: present ? "present" : "MISSING" };
    },
  })),
  {
    name: "0102 · the six boards are exactly the six, and none of them is 'general'",
    why: "A board nobody can characterise is a board nobody subscribes to — §17.2 excludes it deliberately.",
    async run() {
      const rows = await db.execute<{ enumlabel: string }>(sql`
        SELECT e.enumlabel
          FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'community_forum_board'
         ORDER BY e.enumsortorder`);
      const labels = rows.rows.map((row) => row.enumlabel);
      const hasGeneral = labels.includes("general");
      return {
        ok: labels.length === 6 && !hasGeneral,
        detail: `${String(labels.length)} boards${hasGeneral ? ", INCLUDING 'general'" : ""}`,
      };
    },
  },
  {
    name: "0102 · community_forum_thread_state carries 'pending_review'",
    why: "It is the state that keeps A10 closed; without it a create would have to answer 'open'.",
    async run() {
      const present = await enumHasValue("community_forum_thread_state", "pending_review");
      return { ok: present, detail: present ? "present" : "MISSING" };
    },
  },
  {
    name: "0103 · the reply vote is keyed on (reply, USER)",
    why: "Keyed on an organization instead, every individual poster would be unable to endorse anything.",
    async run() {
      const columns = await db.execute<{ attname: string }>(sql`
        SELECT a.attname
          FROM pg_index i
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = 'community_forum_reply_vote'::regclass AND i.indisprimary`);
      const key = columns.rows
        .map((row) => row.attname)
        .toSorted((left, right) => left.localeCompare(right))
        .join(",");
      return { ok: key === "reply_id,user_id", detail: key === "" ? "no primary key" : key };
    },
  },
  {
    name: "0103 · there is NO downvote column anywhere on a reply",
    why: "helpfulCount is a count, not a score: a negative signal against a named organization has no appeal process behind it.",
    async run() {
      const suspicious = await scalar(sql`
        SELECT count(*)::int AS value
          FROM information_schema.columns
         WHERE table_name IN ('community_forum_reply', 'community_forum_reply_vote')
           AND (column_name LIKE '%down%' OR column_name LIKE '%score%'
                OR column_name = 'value' OR column_name = 'vote')`);
      return {
        ok: suspicious === 0,
        detail: `${String(suspicious)} column(s) that could carry a negative signal`,
      };
    },
  },
  {
    name: "0103 · there is NO stored excerpt column",
    why: "A stored excerpt goes stale the moment a body is edited; the card truncates at read time.",
    async run() {
      const found = await scalar(sql`
        SELECT count(*)::int AS value
          FROM information_schema.columns
         WHERE table_name = 'community_forum_thread' AND column_name = 'excerpt'`);
      return {
        ok: found === 0,
        detail: found === 0 ? "absent, as designed" : "PRESENT — stale by construction",
      };
    },
  },
  {
    name: "0103 · a thread REFUSES an accepted reply while it is still open",
    why: "state and acceptedReplyId are derived from each other; letting them disagree makes `answered` a lie.",
    async run() {
      const refused = await probeRefusal(`
        INSERT INTO community_forum_thread
          (id, slug, board, title, body, state, accepted_reply_id, published_at)
        VALUES ('verify-probe-thread', 'verify-probe-thread', 'sourcing',
                'A probe title long enough', 'A probe body long enough to pass the length check.',
                'open', 'some-reply-id', now())`);
      return {
        ok: refused,
        detail: refused ? "refused" : "ACCEPTED an open thread with an answer",
      };
    },
  },
  {
    name: "0103 · a thread REFUSES being pending_review with a publish timestamp",
    why: "published_at is what distinguishes 'never seen by anybody' from 'published and later locked'.",
    async run() {
      const refused = await probeRefusal(`
        INSERT INTO community_forum_thread
          (id, slug, board, title, body, state, published_at)
        VALUES ('verify-probe-thread-2', 'verify-probe-thread-2', 'sourcing',
                'A probe title long enough', 'A probe body long enough to pass the length check.',
                'pending_review', now())`);
      return {
        ok: refused,
        detail: refused ? "refused" : "ACCEPTED a queued thread that claims to be published",
      };
    },
  },
  {
    name: "0103 · a report REFUSES naming two targets at once",
    why: "num_nonnulls = 1 is what lets the projection collapse two nullable FKs into one wire id.",
    async run() {
      const refused = await probeRefusal(`
        INSERT INTO community_content_report
          (id, target_kind, thread_id, reply_id, reason)
        VALUES ('verify-probe-report', 'forum_thread', 'a', 'b', 'spam')`);
      return { ok: refused, detail: refused ? "refused" : "ACCEPTED two targets" };
    },
  },
  {
    name: "0103 · a moderation action CANNOT be stored without an audit entry",
    why: "A decision with no accountable human behind it is what the platform chain exists to prevent.",
    async run() {
      const notNull = await columnIsNotNull("community_moderation_action", "audit_entry_id");
      return {
        ok: notNull,
        detail: notNull ? "audit_entry_id is NOT NULL" : "audit_entry_id is NULLABLE",
      };
    },
  },
  {
    name: "0103 · the browse and queue indexes exist",
    why: "Without them the public list and the moderation queue are both a sequential scan of every thread.",
    async run() {
      const [browse, queue, replies] = await Promise.all([
        indexExists("community_forum_thread_browse_idx"),
        indexExists("community_forum_thread_queue_idx"),
        indexExists("community_forum_reply_thread_idx"),
      ]);
      return {
        ok: browse && queue && replies,
        detail: `browse=${String(browse)} queue=${String(queue)} replies=${String(replies)}`,
      };
    },
  },
  {
    name: "0103 · no thread is BOTH pending_review and carrying a published timestamp",
    why: "The live-data reading of the constraint above: a violation here means something bypassed it.",
    async run() {
      const leaked = await scalar(sql`
        SELECT count(*)::int AS value
          FROM community_forum_thread
         WHERE state = 'pending_review' AND published_at IS NOT NULL`);
      return { ok: leaked === 0, detail: `${String(leaked)} thread(s) in an impossible state` };
    },
  },
];

async function main(): Promise<void> {
  console.log("verify-store-phase-18-constraints\n");
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
