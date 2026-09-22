import { and, eq, inArray } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { caseStudy, showcaseLaunch, teardown } from "#src/db/schema.js";

/**
 * A THIRD PREDICATE, AND IT IS NOT EITHER OF THE TWO READ GATES.
 *
 * `teardown-public-read.service.ts` already holds two apart and warns at length about merging
 * them: LIST (`published`, `flagged`) decides where a teardown may APPEAR, READABLE (those two plus
 * `quarantined`) decides where it may be REACHED. This file adds ENGAGEABLE, and the reason it is a
 * third rather than a reuse of either is a decision about what a quarantine means:
 *
 *   ENGAGEABLE = `published` only, on all three arms.
 *   VIEWABLE   = READABLE on teardowns, LIST on showcases and case studies.
 *
 * ⚠️ LIKE, UPVOTE, SAVE AND COMMENT GATE ON `published` ALONE. `flagged` means a report stands;
 * `quarantined` means an unresolved rights claim. Accruing NEW endorsement on a page the platform
 * is actively withholding is indefensible — the row is under dispute and the platform's own
 * position is that it may not be showing it at all.
 *
 * ⚠️ THE VIEW BEACON GATES ON VIEWABLE INSTEAD, AND THE ASYMMETRY IS DELIBERATE. A quarantined
 * teardown's page IS served — with its notice and its files withheld — so recording that the page
 * was opened is the honest record of something that really happened. Suppressing it would make
 * `view_count` mean "views while undisputed", which is not what any reader of that number assumes.
 *
 * This is exactly the kind of near-duplicate somebody collapses into one predicate with a boolean
 * parameter. Do not. The sibling file's warning applies here word for word: the lists differ by one
 * label, and the result of merging them is either engagement accruing on a withheld page or a
 * beacon that silently stops counting real visits.
 *
 * EVERY GATE FAILURE IS ONE INDISTINGUISHABLE 404. A row that does not exist, a row that is not
 * published, and a row that is quarantined answer with the same bytes — otherwise the difference
 * between the three is an oracle over other people's moderation state.
 *
 * ⚠️ THE TEARDOWN ARM MATCHES ON `slug`, THE OTHER TWO ON `public_slug`, AND THAT IS NOT A TYPO.
 * `teardown.slug` is NOT NULL and present from the start — the schema says so explicitly, "unlike
 * a launch's `public_slug`" — because a teardown is born with an address and a launch is given one
 * by a moderator. The state predicate is what keeps a `pending_review` teardown unreachable here,
 * not the absence of a slug, which is why the two gates below must both carry it.
 */

/** Where a blueprint may ACCRUE ENGAGEMENT. Narrower than either read gate, on every arm. */
const ENGAGEABLE_MODERATION_STATES = ["published"] as const;

/** Where a TEARDOWN's page is served at all — the READABLE list, which the beacon follows. */
const TEARDOWN_VIEWABLE_MODERATION_STATES = ["published", "flagged", "quarantined"] as const;

/**
 * Where a SHOWCASE or CASE STUDY is served — neither arm has a quarantine.
 *
 * ⚠️ `flagged` IS NOT SPECULATIVE ON EITHER ARM ANY MORE. This list was written with two labels
 * while `showcase_launch_moderation_state_ck` still admitted only three states, so the showcase
 * half of it described a row that could not yet exist. It can now, and this file needed NO code
 * change for it — which is the whole reason the list was written this way in the first place.
 *
 * Do not "simplify" either label away. `ENGAGEABLE_MODERATION_STATES` above is `published` alone,
 * and the gap between the two lists is the entire behaviour of a flag: the page still answers, and
 * the row stops accruing likes, upvotes and comments.
 */
const LISTED_MODERATION_STATES = ["published", "flagged"] as const;

export type BlueprintEngagementArm = "showcase" | "teardown" | "case_study";

/**
 * Resolves a public slug to the row's id under the ENGAGEABLE gate.
 *
 * Returns the id and nothing else, deliberately: a caller that needed more would be reading the row
 * twice, and a caller that got more would be tempted to serve it from a write path.
 */
export async function resolveEngageableBlueprint(
  arm: BlueprintEngagementArm,
  slug: string,
): Promise<string | null> {
  switch (arm) {
    case "showcase": {
      const [row] = await db
        .select({ id: showcaseLaunch.id })
        .from(showcaseLaunch)
        .where(
          and(
            eq(showcaseLaunch.publicSlug, slug),
            inArray(showcaseLaunch.moderationState, [...ENGAGEABLE_MODERATION_STATES]),
          ),
        )
        .limit(1);
      return row?.id ?? null;
    }
    case "teardown": {
      const [row] = await db
        .select({ id: teardown.id })
        .from(teardown)
        .where(
          and(
            eq(teardown.slug, slug),
            inArray(teardown.moderationState, [...ENGAGEABLE_MODERATION_STATES]),
          ),
        )
        .limit(1);
      return row?.id ?? null;
    }
    case "case_study": {
      const [row] = await db
        .select({ id: caseStudy.id })
        .from(caseStudy)
        .where(
          and(
            eq(caseStudy.publicSlug, slug),
            inArray(caseStudy.moderationState, [...ENGAGEABLE_MODERATION_STATES]),
          ),
        )
        .limit(1);
      return row?.id ?? null;
    }
    default: {
      const exhaustiveCheck: never = arm;
      throw new Error(`Unhandled blueprint engagement arm: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Resolves a public slug to the row's id under the VIEWABLE gate — the beacon's gate.
 *
 * Wider than `resolveEngageableBlueprint` on the teardown arm by exactly one label, and identical
 * on the other two. See the file docblock for why that one label is the whole point.
 */
export async function resolveViewableBlueprint(
  arm: BlueprintEngagementArm,
  slug: string,
): Promise<string | null> {
  switch (arm) {
    case "showcase": {
      const [row] = await db
        .select({ id: showcaseLaunch.id })
        .from(showcaseLaunch)
        .where(
          and(
            eq(showcaseLaunch.publicSlug, slug),
            inArray(showcaseLaunch.moderationState, [...LISTED_MODERATION_STATES]),
          ),
        )
        .limit(1);
      return row?.id ?? null;
    }
    case "teardown": {
      const [row] = await db
        .select({ id: teardown.id })
        .from(teardown)
        .where(
          and(
            eq(teardown.slug, slug),
            inArray(teardown.moderationState, [...TEARDOWN_VIEWABLE_MODERATION_STATES]),
          ),
        )
        .limit(1);
      return row?.id ?? null;
    }
    case "case_study": {
      const [row] = await db
        .select({ id: caseStudy.id })
        .from(caseStudy)
        .where(
          and(
            eq(caseStudy.publicSlug, slug),
            inArray(caseStudy.moderationState, [...LISTED_MODERATION_STATES]),
          ),
        )
        .limit(1);
      return row?.id ?? null;
    }
    default: {
      const exhaustiveCheck: never = arm;
      throw new Error(`Unhandled blueprint engagement arm: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
