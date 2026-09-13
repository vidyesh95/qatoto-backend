import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { showcaseLaunch, storeSearchDocument, teardown, user } from "#src/db/schema.js";
import type { Result } from "#src/types/index.js";

/**
 * "Is anybody selling this, and has anybody built one?" — the band under a teardown.
 *
 * ⚠️ ITS OWN FILE, because it is the only read on this surface that crosses into `store/`. Burying
 * a store join inside `teardown-public-read.service.ts` would put it in the file whose entire job
 * is holding two visibility gates apart.
 *
 * ⚠️ NO ROLLUP TABLE, AND THAT IS AN ARGUMENT FROM COST RATHER THAN FROM TASTE. A cached
 * `DemandSignal`-style row would have to be invalidated on: product publish, unpublish, price
 * change, category move, stock change, seller suspension, showcase publish, showcase flag, AND a
 * teardown's own `storeProductClass` being edited. `refreshStoreSearchDocument` IS ALREADY THAT
 * INVALIDATION MACHINE for the first six, and it exists precisely because search could not afford
 * the joins. A second rollup would be a weaker, hand-maintained copy of it whose failure mode is
 * showing a founder a price that is not on offer — on the one band whose whole posture is that
 * checking is the point. The store already made this call in writing for
 * `store_pathway_slot_candidate_source_kind`: derived candidates are resolved at READ time,
 * "because a stored copy would be stale the moment a seller edits the graph."
 *
 * Three index scans, two `LIMIT 5` queries, one slug resolution. That is the whole cost.
 *
 * ⚠️ AND `DemandSignal` IS A TAKEN NAME. CLAUDE.md §0 gives it to Market & Civic Intelligence — the
 * Knowledge Hub. Reusing it for a detail-page band would collide with a domain concept that
 * already has an owner.
 */

export type TeardownMarketSignalError = { readonly type: "TEARDOWN_NOT_FOUND" };

export interface TeardownStoreListingSignal {
  readonly productSlug: string;
  readonly title: string;
  readonly organizationDisplayName: string;
  readonly priceInCents: number | null;
  readonly currency: string | null;
}

export interface TeardownShowcaseSignal {
  readonly slug: string;
  readonly title: string;
  readonly authorDisplayName: string;
}

export interface TeardownMarketSignalView {
  readonly storeListings: readonly TeardownStoreListingSignal[];
  readonly showcases: readonly TeardownShowcaseSignal[];
}

/**
 * ⚠️ READABLE, NOT LIST, AND NOT `published`. The detail page reads this band EVEN WHEN THE PAYLOAD
 * IS WITHHELD, and both sides already say why: a quarantine is a claim about the publisher's FILES
 * and says nothing about whether a market for the product exists. Suppressing the band would let a
 * moderation action quietly delete an unrelated fact.
 */
const READABLE_MODERATION_STATES = ["published", "flagged", "quarantined"] as const;

/** The band names ONE class, so it shows listings from exactly that class. */
const MARKET_SIGNAL_LIMIT = 5;

export async function getTeardownMarketSignal(
  teardownSlug: string,
): Promise<Result<TeardownMarketSignalView, TeardownMarketSignalError>> {
  const [target] = await db
    .select({
      slug: teardown.slug,
      storeProductClassCategorySlug: teardown.storeProductClassCategorySlug,
    })
    .from(teardown)
    .where(
      and(
        eq(teardown.slug, teardownSlug),
        inArray(teardown.moderationState, [...READABLE_MODERATION_STATES]),
      ),
    )
    .limit(1);

  if (!target) return { success: false, error: { type: "TEARDOWN_NOT_FOUND" } };

  const categorySlug = target.storeProductClassCategorySlug;

  const [storeListings, showcases] = await Promise.all([
    /*
     * ⚠️ THE EXACT CATEGORY SLUG, WITH NO SUBTREE EXPANSION. `listActiveCategorySubtreeSlugs`
     * exists and is deliberately not used here: the band's heading NAMES the class, and the
     * component's own comment says "'3 listings' without saying of what is a number a reader
     * cannot check." A subtree would make the heading false.
     *
     * Cheapest first, because the band's whole claim is "somebody is selling this, at a price,
     * today" and the cheapest comparable listing is the single most useful number for a founder
     * pricing a build. `store_search_document_category_price_idx` is what makes that sort free.
     */
    categorySlug === null
      ? Promise.resolve<readonly TeardownStoreListingSignal[]>([])
      : db
          .select({
            productSlug: storeSearchDocument.publicSlug,
            title: storeSearchDocument.title,
            organizationDisplayName: storeSearchDocument.organizationDisplayName,
            priceInCents: storeSearchDocument.priceInCents,
            currency: storeSearchDocument.currency,
          })
          .from(storeSearchDocument)
          .where(
            and(
              eq(storeSearchDocument.isEligible, true),
              eq(storeSearchDocument.documentKind, "product"),
              eq(storeSearchDocument.categorySlug, categorySlug),
              /*
               * ⚠️ `IS NULL OR <> 'discontinued'`, NOT A BARE INEQUALITY. `selling_state` is
               * nullable for offerings and organizations, and the schema warns that a bare
               * inequality "would drop every offering and supplier". The `document_kind` filter
               * makes it moot here, but it is written the way search writes it so the two cannot
               * drift apart.
               */
              sql`(${storeSearchDocument.sellingState} IS NULL OR ${storeSearchDocument.sellingState} <> 'discontinued')`,
            ),
          )
          .orderBy(
            sql`${storeSearchDocument.priceInCents} ASC NULLS LAST`,
            asc(storeSearchDocument.id),
          )
          .limit(MARKET_SIGNAL_LIMIT),

    /*
     * The reverse lookup on `built_from_blueprint_slug` — free text with a slug shape and no
     * foreign key, so this is a string match by design rather than a join that could be an FK.
     *
     * An INNER JOIN to `user`, because `showcase_launch` carries no denormalised byline the way
     * `teardown` does. A launch whose author was erased is gone with them (`author_user_id` is
     * `cascade`), so the join cannot silently drop a row that should have shown.
     */
    db
      .select({
        slug: showcaseLaunch.publicSlug,
        title: showcaseLaunch.title,
        authorDisplayName: user.name,
      })
      .from(showcaseLaunch)
      .innerJoin(user, eq(user.id, showcaseLaunch.authorUserId))
      .where(
        and(
          /*
           * ⚠️ MUST MATCH `showcase_launch_built_from_idx`'S PREDICATE, which is
           * `IN ('published','flagged')`. This query is that index's only caller. Narrow it back to
           * `= 'published'` and nothing fails — Postgres just stops using the index, silently.
           * `flagged` belongs here on its own merits too: a flag changes nothing a visitor sees.
           */
          inArray(showcaseLaunch.moderationState, ["published", "flagged"]),
          isNotNull(showcaseLaunch.builtFromBlueprintSlug),
          eq(showcaseLaunch.builtFromBlueprintSlug, target.slug),
        ),
      )
      .orderBy(desc(showcaseLaunch.launchedAt), asc(showcaseLaunch.id))
      .limit(MARKET_SIGNAL_LIMIT),
  ]);

  /*
   * ⚠️ TWO ARRAYS, NEVER `null`, EVEN WHEN BOTH ARE EMPTY. The frontend's rule is that an empty
   * band is hidden — but that is a RENDERING decision and it belongs on the page. `null` on the
   * wire would make "nothing is selling" and "the backend answered" the same shape, and a reader
   * of this endpoint could not tell them apart either.
   */
  return {
    success: true,
    value: {
      storeListings,
      showcases: showcases.flatMap((row) =>
        row.slug === null
          ? []
          : [{ slug: row.slug, title: row.title, authorDisplayName: row.authorDisplayName }],
      ),
    },
  };
}
