/**
 * Asserts the STORE Phase 14 invariants against a live database.
 *
 *   pnpm run db:verify-store-phase-14-constraints
 *
 * WHAT A VERIFIER IS FOR HERE, restated because Phase 14 makes it sharper than usual. Most
 * of these rules are already database constraints, and re-asserting a CHECK proves little.
 * What earns a run is the rule a constraint cannot express, and above all the TRIGGER that
 * must actually REFUSE a write — its presence in `pg_trigger` says nothing about its body,
 * and a rail guard whose body is wrong looks identical to one that works.
 *
 * The load-bearing check in this file is the memo identity:
 *
 *     funding + custody + released + refunded = 0     (per order, always)
 *
 * If that ever fails, gross value has been recorded as having moved somewhere it did not,
 * and every settlement figure downstream of it is fiction.
 *
 * Read-only apart from four deliberate probes, each rolled back.
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
  // `count(*)::int` arrives as a number; no conversion needed.
  return result.rows[0]?.value ?? 0;
}

/**
 * Runs a statement and reports whether the database REFUSED it, rolling back either way.
 *
 * `expectRefusal` is the whole point: a guard that silently accepts a write it should have
 * rejected is the failure mode this file exists to catch, and only an attempted write can
 * distinguish that from a guard that works.
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

async function anyOrderOnRail(rail: string): Promise<{ id: string; currency: string } | null> {
  const result = await db.execute<{ id: string; currency: string }>(sql`
    SELECT id, currency FROM commerce_order
     WHERE settlement_rail = ${rail}
     ORDER BY created_at
     LIMIT 1`);
  return result.rows[0] ?? null;
}

const CHECKS: readonly Check[] = [
  {
    name: "the memo identity holds for every order",
    why: "A non-zero sum means gross value was recorded moving somewhere it did not.",
    run: async () => {
      /**
       * `sum(...)` over bigint comes back as a STRING from the driver, so the comparison is
       * done in SQL rather than in JavaScript. A row type claiming `number` here would let
       * lint delete the conversion and the check would compare a string to a number.
       */
      const bad = await scalar(sql`
        SELECT count(*)::int AS value FROM (
          SELECT order_id
            FROM commerce_journal_line
           WHERE account_kind::text LIKE 'settlement_%_memo'
           GROUP BY order_id
          HAVING sum(signed_amount_in_cents) <> 0
        ) AS unbalanced`);
      return { ok: bad === 0, detail: `${String(bad)} order(s) whose memo accounts do not net to zero` };
    },
  },
  {
    name: "is_memorandum agrees with the account kind",
    why: "The flag exists so no balance report can sum memo value and real money as one.",
    run: async () => {
      const bad = await scalar(sql`
        SELECT count(*)::int AS value FROM commerce_journal_account
         WHERE is_memorandum <> (kind::text IN ('settlement_funding_memo', 'settlement_custody_memo',
                                               'settlement_released_memo', 'settlement_refunded_memo'))`);
      return { ok: bad === 0, detail: `${String(bad)} account(s) with a mislabelled memorandum flag` };
    },
  },
  {
    name: "no journal line names an account its rail forbids",
    why: "order_held on an escrow order would assert custody Qatoto does not have.",
    run: async () => {
      const bad = await scalar(sql`
        SELECT count(*)::int AS value
          FROM commerce_journal_line line
          JOIN commerce_order o ON o.id = line.order_id
         WHERE (o.settlement_rail = 'internal_custody'
                  AND line.account_kind::text LIKE 'settlement_%_memo')
            OR (o.settlement_rail = 'direct_offline'
                  AND line.account_kind::text NOT IN ('platform_fee_receivable',
                        'platform_fee_earned', 'platform_fee_cash', 'reconciliation_suspense'))
            OR (o.settlement_rail = 'direct_processor'
                  AND line.account_kind::text IN ('buyer_clearing', 'order_held',
                        'seller_payable', 'platform_fee', 'refunds_payable',
                        'settlement_custody_memo'))
            OR (o.settlement_rail = 'external_escrow'
                  AND line.account_kind::text IN ('buyer_clearing', 'order_held',
                        'seller_payable', 'platform_fee', 'refunds_payable'))`);
      return { ok: bad === 0, detail: `${String(bad)} line(s) on a rail that forbids their account` };
    },
  },
  {
    name: "seller_payable is still unposted",
    why: "It means Qatoto owes the seller money it holds, which under no-custody cannot be true.",
    run: async () => {
      const bad = await scalar(sql`
        SELECT count(*)::int AS value FROM commerce_journal_line
         WHERE account_kind::text = 'seller_payable'`);
      return { ok: bad === 0, detail: `${String(bad)} seller_payable posting(s)` };
    },
  },
  {
    name: "a direct_offline order carries no settlement entry",
    why: "Qatoto cannot observe a wire between two banks; a memo there is a fact from an absence.",
    run: async () => {
      const bad = await scalar(sql`
        SELECT count(*)::int AS value
          FROM commerce_journal_line line
          JOIN commerce_order o ON o.id = line.order_id
         WHERE o.settlement_rail = 'direct_offline'
           AND line.account_kind::text LIKE 'settlement_%_memo'`);
      return { ok: bad === 0, detail: `${String(bad)} memo line(s) on an offline-settled order` };
    },
  },
  {
    name: "escrow milestones sum to their session total",
    why: "A plan that does not account for the whole order can never fully release.",
    run: async () => {
      const bad = await scalar(sql`
        SELECT count(*)::int AS value FROM (
          SELECT s.id
            FROM commerce_external_escrow_session s
            JOIN commerce_escrow_milestone m ON m.session_id = s.id
           GROUP BY s.id, s.total_in_cents
          HAVING sum(m.amount_in_cents) <> s.total_in_cents
        ) AS mismatched`);
      return { ok: bad === 0, detail: `${String(bad)} session(s) whose milestones do not sum to the total` };
    },
  },
  {
    name: "agreement milestones sum to the agreement total",
    why: "The deferred trigger enforces it on write; this catches anything that bypassed it.",
    run: async () => {
      const bad = await scalar(sql`
        SELECT count(*)::int AS value FROM (
          SELECT a.id
            FROM commerce_settlement_agreement a
            JOIN commerce_settlement_agreement_milestone m ON m.agreement_id = a.id
           GROUP BY a.id, a.total_in_cents
          HAVING sum(m.amount_in_cents) <> a.total_in_cents
        ) AS mismatched`);
      return { ok: bad === 0, detail: `${String(bad)} agreement(s) whose plan does not sum to the total` };
    },
  },
  {
    name: "no agreement was accepted by its own proposer",
    why: "A proposer accepting its own terms is not a mutual agreement.",
    run: async () => {
      const bad = await scalar(sql`
        SELECT count(*)::int AS value FROM commerce_settlement_agreement
         WHERE accepted_by_organization_id IS NOT NULL
           AND accepted_by_organization_id = proposed_by_organization_id`);
      return { ok: bad === 0, detail: `${String(bad)} self-accepted agreement(s)` };
    },
  },
  {
    name: "at most one live accepted agreement per party pair per thread",
    why: "Two would make checkout guess which terms the buyer meant.",
    run: async () => {
      const bad = await scalar(sql`
        SELECT count(*)::int AS value FROM (
          SELECT thread_id
            FROM commerce_settlement_agreement
           WHERE state = 'accepted'
           GROUP BY thread_id, buyer_organization_id, seller_organization_id
          HAVING count(*) > 1
        ) AS duplicated`);
      return { ok: bad === 0, detail: `${String(bad)} party pair(s) holding two accepted agreements` };
    },
  },
  {
    name: "a consumed agreement names its order and vice versa",
    why: "An agreement spent by no order, or an order spending none, breaks the audit trail.",
    run: async () => {
      const bad = await scalar(sql`
        SELECT count(*)::int AS value FROM commerce_settlement_agreement
         WHERE (state = 'consumed') <> (consumed_by_order_id IS NOT NULL)`);
      return { ok: bad === 0, detail: `${String(bad)} agreement(s) with inconsistent consumption` };
    },
  },
  {
    name: "every escrow session belongs to an order on the escrow rail",
    why: "A session against a directly-settled order is an escrow nobody agreed to.",
    run: async () => {
      const bad = await scalar(sql`
        SELECT count(*)::int AS value
          FROM commerce_external_escrow_session s
          JOIN commerce_order o ON o.id = s.order_id
         WHERE o.settlement_rail <> 'external_escrow'`);
      return { ok: bad === 0, detail: `${String(bad)} session(s) on a non-escrow order` };
    },
  },
  {
    name: "no released milestone predates its session funding",
    why: "Money cannot leave an escrow before it entered one.",
    run: async () => {
      const bad = await scalar(sql`
        SELECT count(*)::int AS value
          FROM commerce_escrow_milestone m
          JOIN commerce_external_escrow_session s ON s.id = m.session_id
         WHERE m.released_at IS NOT NULL
           AND (s.funded_at IS NULL OR m.released_at < s.funded_at)`);
      return { ok: bad === 0, detail: `${String(bad)} milestone(s) released before funding` };
    },
  },
  {
    name: "the inbox cannot hold a duplicate provider event",
    why: "This index is the entire replay defence for an unauthenticated route.",
    run: async () => {
      const bad = await scalar(sql`
        SELECT count(*)::int AS value FROM (
          SELECT provider_id
            FROM commerce_connector_webhook_event
           GROUP BY provider_id, provider_event_id
          HAVING count(*) > 1
        ) AS duplicated`);
      return { ok: bad === 0, detail: `${String(bad)} duplicated provider event id(s)` };
    },
  },
  {
    name: "no provider row stores a secret in place of its name",
    why: "The columns hold an env var NAME; a value there would put a live key at rest.",
    run: async () => {
      /**
       * A heuristic, deliberately. It cannot prove a string is not a secret, but an env var
       * name is SCREAMING_SNAKE_CASE and an API key almost never is, so anything else in
       * these columns is worth a human look.
       */
      const bad = await scalar(sql`
        SELECT count(*)::int AS value FROM commerce_external_provider
         WHERE (credential_ref IS NOT NULL AND credential_ref !~ '^[A-Z][A-Z0-9_]{2,80}$')
            OR (webhook_signing_secret_ref IS NOT NULL
                  AND webhook_signing_secret_ref !~ '^[A-Z][A-Z0-9_]{2,80}$')`);
      return { ok: bad === 0, detail: `${String(bad)} provider row(s) whose ref is not an env var name` };
    },
  },

  // --- Probes. Each attempts a write the database must refuse, and rolls back. ---

  {
    name: "the rail guard REFUSES a memo account on a custody order",
    why: "Presence in pg_trigger proves nothing; only an attempted write proves the body.",
    run: async () => {
      const order = await anyOrderOnRail("internal_custody");
      if (!order) return { ok: true, detail: "skipped — no internal_custody order to probe" };
      const refused = await probeRefusal(
        `INSERT INTO commerce_journal_account (id, order_id, kind, currency, is_memorandum)
         VALUES ('verify_probe_memo', '${order.id}', 'settlement_custody_memo', '${order.currency}', true)`,
      );
      return {
        ok: refused,
        detail: refused ? "refused" : "ACCEPTED a memo account on a custody order",
      };
    },
  },
  {
    name: "the rail guard still PERMITS order_held on a custody order",
    why: "A guard that refuses everything is not a guard, it is an outage.",
    run: async () => {
      const order = await anyOrderOnRail("internal_custody");
      if (!order) return { ok: true, detail: "skipped — no internal_custody order to probe" };
      const refused = await probeRefusal(
        `INSERT INTO commerce_journal_account (id, order_id, kind, currency, is_memorandum)
         VALUES ('verify_probe_held', '${order.id}', 'order_held', '${order.currency}', false)`,
      );
      return {
        ok: !refused,
        detail: refused ? "REFUSED a legitimate legacy account" : "permitted, as it should be",
      };
    },
  },
  {
    name: "the memorandum flag cannot be set against its kind",
    why: "The flag is derived; a writer must not be able to lie about it.",
    run: async () => {
      const order = await anyOrderOnRail("internal_custody");
      if (!order) return { ok: true, detail: "skipped — no internal_custody order to probe" };
      const refused = await probeRefusal(
        `INSERT INTO commerce_journal_account (id, order_id, kind, currency, is_memorandum)
         VALUES ('verify_probe_flag', '${order.id}', 'order_held', '${order.currency}', true)`,
      );
      return { ok: refused, detail: refused ? "refused" : "ACCEPTED a mislabelled memorandum flag" };
    },
  },
  {
    name: "settlement_rail is immutable once an order exists",
    why: "A mutable rail lets a confirmed unprotected order be relabelled as protected.",
    run: async () => {
      const order = await anyOrderOnRail("internal_custody");
      if (!order) return { ok: true, detail: "skipped — no internal_custody order to probe" };
      const refused = await probeRefusal(
        `UPDATE commerce_order SET settlement_rail = 'external_escrow' WHERE id = '${order.id}'`,
      );
      return { ok: refused, detail: refused ? "refused" : "ACCEPTED a rail change on a live order" };
    },
  },
];

async function main(): Promise<void> {
  console.log("verify-store-phase-14-constraints\n");
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
