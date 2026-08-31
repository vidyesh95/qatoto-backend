import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { commerceProductRelation } from "#src/db/schema.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";

/**
 * Mines product co-occurrence from completed orders into the relation graph
 * (STORE_BACKEND_STRUCTURE.md §15.9).
 *
 * `derived_cooccurrence` has existed in `commerce_product_relation_source_kind` since
 * Phase 8 and nothing wrote it; this closes that. The derived edges feed anchored
 * pathway slots (§15.2) and `GET /store/products/:slug/companions` at no extra cost —
 * one table, five surfaces, as §15.3 promised.
 *
 * TWO RULES GOVERN THIS JOB, and both are about not overwriting a human.
 *
 *  1. A `seller_declared` or `moderator_curated` edge is never touched. The unique
 *     index is `(from_product_id, to_product_id, relation_kind)` and carries NO source
 *     kind, so an upsert would silently rewrite a moderator's verified compatibility
 *     claim as a machine guess. Pairs that already have an edge of this kind are
 *     skipped entirely.
 *  2. Only previously derived rows are deleted before the re-insert, so a rerun
 *     refreshes its own output and nothing else.
 *
 * The edges are written as `complements`, which is the honest reading of "these were
 * bought together". Co-occurrence is NOT evidence of fitment: it cannot support
 * `compatible_with` or `spare_part_of`, and claiming otherwise would turn a
 * correlation into the safety claim §15.3 reserves for `moderator_curated`.
 */

/** Symmetric, so each pair is written both ways — one query direction serves every read. */
const DERIVED_RELATION_KIND = "complements" as const;

/**
 * How many completed orders must contain a pair before it becomes an edge. Two orders
 * is one buyer changing their mind twice; three is a pattern.
 */
const MINIMUM_CO_OCCURRENCE_SUPPORT = 3;

/** Bounded so one night's run cannot write an unbounded graph. */
const MAXIMUM_DERIVED_EDGES = 5000;
const MAXIMUM_EDGES_PER_PRODUCT = 12;

interface CoOccurringPair {
  readonly fromProductId: string;
  readonly toProductId: string;
  readonly orderCount: number;
}

export async function handleDeriveProductRelations(rawPayload: unknown): Promise<void> {
  parseJobPayload(
    JOB_NAMES.deriveProductRelations,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.deriveProductRelations],
    rawPayload,
  );

  const pairs = await loadCoOccurringPairs();
  const rankedPairs = rankPairsPerProduct(pairs);

  await db.transaction(async (transaction) => {
    // Rule 2: this job owns its own rows and nothing else's.
    await transaction
      .delete(commerceProductRelation)
      /**
       * ⚠️ **A DISMISSED DERIVED ROW IS NOT THIS JOB'S TO RECLAIM.** Without the second predicate
       * the nightly wipe deletes a moderator's refusal and the next pass re-derives the edge
       * undismissed — dismissal silently undone overnight. The `humanAuthoredPairs` read below is
       * unfiltered, so a surviving dismissed row is still seen and its pair skipped: no collision.
       */
      .where(
        and(
          eq(commerceProductRelation.sourceKind, "derived_cooccurrence"),
          isNull(commerceProductRelation.dismissedAt),
        ),
      );

    if (rankedPairs.length === 0) return;

    /**
     * Rule 1. Read the surviving edges AFTER the delete: a pair that a seller or a
     * moderator has spoken about keeps their edge, and the derived one is not written
     * at all rather than being written and losing a race with the unique index.
     */
    const humanAuthoredPairs = await transaction
      .select({
        fromProductId: commerceProductRelation.fromProductId,
        toProductId: commerceProductRelation.toProductId,
      })
      .from(commerceProductRelation)
      .where(eq(commerceProductRelation.relationKind, DERIVED_RELATION_KIND));
    const claimedPairKeys = new Set(
      humanAuthoredPairs.map((row) => `${row.fromProductId}:${row.toProductId}`),
    );

    const insertableRows = rankedPairs
      .filter((pair) => !claimedPairKeys.has(`${pair.fromProductId}:${pair.toProductId}`))
      .map((pair) => ({
        fromProductId: pair.fromProductId,
        toProductId: pair.toProductId,
        relationKind: DERIVED_RELATION_KIND,
        sourceKind: "derived_cooccurrence" as const,
        rank: pair.rank,
      }));

    // Chunked because a single 5000-row insert exceeds comfortable parameter counts.
    for (let offset = 0; offset < insertableRows.length; offset += 500) {
      await transaction
        .insert(commerceProductRelation)
        .values(insertableRows.slice(offset, offset + 500));
    }
  });
}

/**
 * Pairs of distinct products appearing in the same COMPLETED order, both directions.
 *
 * `quantity_cancelled`/`quantity_refunded` are deliberately ignored: an order that
 * completed is evidence the two products were bought together, and a partial refund
 * afterwards does not undo that they were chosen together.
 */
async function loadCoOccurringPairs(): Promise<readonly CoOccurringPair[]> {
  /**
   * Written as raw SQL because this is a self-join with two aliases of one table, which
   * the query builder cannot express without fighting it. `db.execute` is the shape
   * `prune-engagement-data.ts` already uses for the same reason.
   */
  const result = await db.execute<{
    from_product_id: string;
    to_product_id: string;
    order_count: number;
  }>(sql`
    SELECT
      left_line.product_id  AS from_product_id,
      right_line.product_id AS to_product_id,
      count(DISTINCT left_line.order_id)::int AS order_count
    FROM commerce_order_product_line AS left_line
    JOIN commerce_order_product_line AS right_line
      ON right_line.order_id = left_line.order_id
     AND right_line.product_id <> left_line.product_id
    JOIN commerce_order
      ON commerce_order.id = left_line.order_id
    WHERE commerce_order.state = 'completed'
      AND left_line.product_id IS NOT NULL
      AND right_line.product_id IS NOT NULL
    GROUP BY left_line.product_id, right_line.product_id
    HAVING count(DISTINCT left_line.order_id) >= ${MINIMUM_CO_OCCURRENCE_SUPPORT}
    ORDER BY count(DISTINCT left_line.order_id) DESC,
             left_line.product_id ASC,
             right_line.product_id ASC
    LIMIT ${MAXIMUM_DERIVED_EDGES}
  `);

  return result.rows.map((row) => ({
    fromProductId: row.from_product_id,
    toProductId: row.to_product_id,
    orderCount: row.order_count,
  }));
}

/**
 * Ranks each product's companions by how often they were bought with it, keeping the
 * strongest few. Rank 0 is the strongest signal, matching what the companions read and
 * the pathway slot both expect.
 */
export function rankPairsPerProduct(
  pairs: readonly CoOccurringPair[],
): readonly (CoOccurringPair & { readonly rank: number })[] {
  const pairsByFromProductId = new Map<string, CoOccurringPair[]>();
  for (const pair of pairs) {
    const companions = pairsByFromProductId.get(pair.fromProductId) ?? [];
    companions.push(pair);
    pairsByFromProductId.set(pair.fromProductId, companions);
  }

  return [...pairsByFromProductId.values()].flatMap((companions) =>
    companions
      .toSorted(
        (left, right) =>
          right.orderCount - left.orderCount || left.toProductId.localeCompare(right.toProductId),
      )
      .slice(0, MAXIMUM_EDGES_PER_PRODUCT)
      .map((pair, companionIndex) => ({ ...pair, rank: companionIndex })),
  );
}
