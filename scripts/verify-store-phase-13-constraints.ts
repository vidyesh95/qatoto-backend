/**
 * Asserts the STORE Phase 13 invariants against a live database.
 *
 *   pnpm run db:verify-store-phase-13-constraints
 *
 * WHAT A VERIFIER IS FOR HERE. Most of these rules are already database constraints, and
 * re-asserting a CHECK adds little. The ones worth running are the rules a constraint cannot
 * express: that a trigger actually REFUSES a write (its presence in `pg_trigger` proves
 * nothing about its body), that a derived counter still agrees with the rows behind it, and
 * that the scoring regime a row claims matches the evidence it carries.
 *
 * Read-only apart from one deliberate probe, which is rolled back.
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

const CHECKS: readonly Check[] = [
  {
    name: "components sum to the total",
    why: "A scorer bug must be a write failure, not a silently wrong ranking.",
    run: async () => {
      const bad = await scalar(sql`
        SELECT count(*)::int AS value FROM commerce_product_trending_snapshot
         WHERE qualified_velocity_points + demand_freshness_points + conversion_quality_points
               + seller_trust_points + buyer_engagement_points <> trending_score_points`);
      return { ok: bad === 0, detail: `${String(bad)} row(s) whose components disagree` };
    },
  },
  {
    name: "a penalty never promotes",
    why: "Every multiplier is bounded at 1.0, so the final score cannot exceed the base.",
    run: async () => {
      const bad = await scalar(sql`
        SELECT count(*)::int AS value FROM commerce_product_trending_snapshot
         WHERE final_score_points > trending_score_points OR final_score_points < 0`);
      return { ok: bad === 0, detail: `${String(bad)} row(s) where final exceeded base` };
    },
  },
  {
    name: "every rate ships its sample size",
    why: "Scored-0-because-unmeasurable and scored-0-because-zero must stay distinguishable.",
    run: async () => {
      const bad = await scalar(sql`
        SELECT count(*)::int AS value FROM commerce_product_trending_snapshot
         WHERE (conversion_rate_bp IS NULL) <> (conversion_sample_size IS NULL)
            OR (seller_on_time_rate_bp IS NULL) <> (seller_on_time_sample_size IS NULL)
            OR (subnet_concentration_bp IS NULL) <> (subnet_sample_size IS NULL)`);
      return { ok: bad === 0, detail: `${String(bad)} row(s) with an unpaired rate` };
    },
  },
  {
    name: "no percentile claim without qualified W2 demand",
    why: "THE regression this phase most fears: an empty rail 'fixed' by loosening the gate.",
    run: async () => {
      const bad = await scalar(sql`
        SELECT count(*)::int AS value FROM commerce_product_trending_snapshot
         WHERE ranking_mode = 'percentile' AND qualified_orders_w2 = 0`);
      return {
        ok: bad === 0,
        detail: `${String(bad)} row(s) claiming percentile with no W2 demand`,
      };
    },
  },
  {
    name: "share_count equals the counted rows behind it",
    why: "0076 reconciled it once; this keeps every future writer honest.",
    run: async () => {
      const bad = await scalar(sql`
        SELECT count(*)::int AS value
          FROM commerce_product_stats s
          LEFT JOIN (SELECT product_id, count(*)::int AS total
                       FROM commerce_product_share WHERE counted GROUP BY product_id) c
            ON c.product_id = s.product_id
         WHERE s.share_count <> coalesce(c.total, 0)`);
      return { ok: bad === 0, detail: `${String(bad)} product(s) with a drifted share counter` };
    },
  },
  {
    name: "no anonymous share is counted",
    why: "An anonymous caller must not be able to push a ranking input.",
    run: async () => {
      const bad = await scalar(sql`
        SELECT count(*)::int AS value FROM commerce_product_share
         WHERE counted AND user_id IS NULL`);
      return { ok: bad === 0, detail: `${String(bad)} counted anonymous share(s)` };
    },
  },
  {
    name: "an unevaluated qualification carries no reasons",
    why: "A historical order must not look like it was assessed and found wanting.",
    run: async () => {
      const bad = await scalar(sql`
        SELECT count(*)::int AS value FROM commerce_order
         WHERE (buyer_qualification_state = 'unevaluated') <> (cardinality(buyer_qualification_reasons) = 0)`);
      return { ok: bad === 0, detail: `${String(bad)} order(s) with a mismatched verdict` };
    },
  },
  {
    name: "an automatic enforcement names nobody",
    why: "platform_audit_entry.actor_user_id is NOT NULL; an automatic action has no actor.",
    run: async () => {
      const bad = await scalar(sql`
        SELECT count(*)::int AS value FROM commerce_ranking_enforcement_event
         WHERE (action_source = 'automatic') <> (decided_by_user_id IS NULL)`);
      return { ok: bad === 0, detail: `${String(bad)} event(s) with a mismatched actor` };
    },
  },
  {
    name: "a default_floor prior claims no observations",
    why: "The floor exists because nothing above it had evidence; it must not pretend to.",
    run: async () => {
      const bad = await scalar(sql`
        SELECT count(*)::int AS value FROM commerce_category_demand_snapshot
         WHERE prior_level = 'default_floor' AND prior_sample_size <> 0`);
      return { ok: bad === 0, detail: `${String(bad)} floor prior(s) claiming a sample` };
    },
  },
  {
    name: "the discovery-score trigger REFUSES an unprivileged write",
    why:
      "Presence in pg_trigger proves nothing about the body. This is the only check here " +
      "that writes, and it rolls back.",
    run: async () => {
      let moved = -1;
      await db
        .transaction(async (transaction) => {
          // Deliberately WITHOUT `SET LOCAL qatoto.ranking_writer`.
          await transaction.execute(sql`
            UPDATE store_search_document SET discovery_score_points = 42
             WHERE discovery_score_points IS NOT NULL`);
          const result = await transaction.execute<{ value: number }>(sql`
            SELECT count(*)::int AS value FROM store_search_document
             WHERE discovery_score_points = 42`);
          moved = result.rows[0]?.value ?? 0;
          // Always roll back: this probe must not leave a trace even when it passes.
          throw new Error("verify-probe-rollback");
        })
        .catch((error: unknown) => {
          if (!(error instanceof Error) || error.message !== "verify-probe-rollback") throw error;
        });

      return {
        ok: moved === 0,
        detail:
          moved === 0
            ? "trigger reverted the write"
            : `${String(moved)} row(s) were changed by a writer that did not announce itself`,
      };
    },
  },
];

async function main(): Promise<void> {
  console.log("verify-store-phase-13-constraints\n");
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
