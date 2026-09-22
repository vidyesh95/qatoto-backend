import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  caseStudy,
  caseStudyLike,
  caseStudyStats,
  caseStudyViewSession,
  showcaseLaunch,
  showcaseLaunchLike,
  showcaseLaunchStats,
  showcaseLaunchUpvote,
  showcaseLaunchViewSession,
  teardown,
  teardownLike,
  teardownSave,
  teardownStats,
  teardownViewSession,
} from "#src/db/schema.js";
import {
  resolveEngageableBlueprint,
  resolveViewableBlueprint,
} from "#src/modules/home/blueprints/blueprint-engagement-gate.js";
import type { BlueprintEngagementArm } from "#src/modules/home/blueprints/blueprint-engagement-gate.js";
import { decrement, increment } from "#src/modules/home/counter-sql.js";
import type { Result } from "#src/types/index.js";

/**
 * The viewer-side writes on the `/blueprints` surface.
 *
 * EVERY COUNTER MOVES IN THE SAME TRANSACTION AS THE ROW THAT CAUSED IT — the discipline
 * `video-engagement.service.ts` states, and its reason transfers unchanged: a like that commits
 * without its counter is a like that disappears from the UI until a reconciler runs, and that
 * reconciler is the job we are trying not to need.
 *
 * ⚠️ EVERY COUNTER WRITE IS AN UPSERT, NEVER A BARE `UPDATE`, AND THAT IS NOT DEFENSIVENESS.
 * `showcase_launch_stats` mints NO ROW ON PUBLISH — the schema says so and
 * `db:smoke-showcase-authoring` asserts it — so a plain `UPDATE ... WHERE launch_id = $1` against a
 * launch nobody has touched affects ZERO ROWS and the count is silently lost. The row is minted by
 * the FIRST ENGAGEMENT. Writing all three arms as upserts means one shape serves the arm that mints
 * on publish and the arm that does not, and a missing sidecar self-heals instead of losing counts.
 *
 * ⚠️ THE COUNTER MOVES ONLY WHEN A ROW WAS ACTUALLY INSERTED OR DELETED. Every insert here is
 * `ON CONFLICT DO NOTHING ... RETURNING`, and an empty `returning()` means the row was already
 * there. Incrementing on a swallowed conflict is exactly how a double-tapped like inflates a count.
 */

export type BlueprintEngagementError =
  | { readonly type: "BLUEPRINT_CONTENT_NOT_FOUND" }
  /** The arm does not offer this verb at all — a showcase cannot be saved, a case study upvoted. */
  | { readonly type: "BLUEPRINT_VERB_NOT_AVAILABLE_ON_ARM"; readonly arm: BlueprintEngagementArm };

/** What a toggle answers with: the resulting state, and the server's own count. */
export interface BlueprintToggleOutcome {
  readonly isSet: boolean;
  readonly count: number;
}

export interface BlueprintViewBeaconInput {
  readonly arm: BlueprintEngagementArm;
  readonly slug: string;
  /** NULL for an anonymous viewer. */
  readonly viewerUserId: string | null;
  readonly viewerFingerprint: string;
  /** ⚠️ THE SAME STRING THAT WENT INTO THE HASH — see `ViewerFingerprintInput.utcDayString`. */
  readonly viewDayBucket: string;
}

// ---------------------------------------------------------------------------
// The beacon
// ---------------------------------------------------------------------------

/**
 * Records that one blueprint's page was opened, once per viewer per UTC day.
 *
 * ⚠️ GATED ON VIEWABLE, NOT ON ENGAGEABLE. A quarantined teardown's page IS served — with its
 * notice and its files withheld — so recording that it was opened is the honest record of something
 * that really happened. See `blueprint-engagement-gate.ts` for why that is a third predicate rather
 * than a reuse of either read gate.
 *
 * Answers NOTHING on success. Echoing the resulting count back would hand an attacker a live
 * readout to tune against, which is the same oracle rule the video beacon states.
 */
export async function recordBlueprintView(
  input: BlueprintViewBeaconInput,
): Promise<Result<null, BlueprintEngagementError>> {
  const targetId = await resolveViewableBlueprint(input.arm, input.slug);
  if (targetId === null) return { success: false, error: { type: "BLUEPRINT_CONTENT_NOT_FOUND" } };

  await db.transaction(async (transaction) => {
    switch (input.arm) {
      case "showcase": {
        const inserted = await transaction
          .insert(showcaseLaunchViewSession)
          .values({
            launchId: targetId,
            viewerUserId: input.viewerUserId,
            viewerFingerprint: input.viewerFingerprint,
            viewDayBucket: input.viewDayBucket,
          })
          .onConflictDoNothing()
          .returning({ id: showcaseLaunchViewSession.id });
        if (inserted.length === 0) return;
        await transaction
          .insert(showcaseLaunchStats)
          .values({ launchId: targetId, viewCount: 1 })
          .onConflictDoUpdate({
            target: showcaseLaunchStats.launchId,
            set: {
              viewCount: increment(showcaseLaunchStats.viewCount),
              updatedAt: sql`now()`,
            },
          });
        return;
      }
      case "teardown": {
        const inserted = await transaction
          .insert(teardownViewSession)
          .values({
            teardownId: targetId,
            viewerUserId: input.viewerUserId,
            viewerFingerprint: input.viewerFingerprint,
            viewDayBucket: input.viewDayBucket,
          })
          .onConflictDoNothing()
          .returning({ id: teardownViewSession.id });
        if (inserted.length === 0) return;
        await transaction
          .insert(teardownStats)
          .values({ teardownId: targetId, viewCount: 1 })
          .onConflictDoUpdate({
            target: teardownStats.teardownId,
            set: { viewCount: increment(teardownStats.viewCount), updatedAt: sql`now()` },
          });
        return;
      }
      case "case_study": {
        const inserted = await transaction
          .insert(caseStudyViewSession)
          .values({
            caseStudyId: targetId,
            viewerUserId: input.viewerUserId,
            viewerFingerprint: input.viewerFingerprint,
            viewDayBucket: input.viewDayBucket,
          })
          .onConflictDoNothing()
          .returning({ id: caseStudyViewSession.id });
        if (inserted.length === 0) return;
        await transaction
          .insert(caseStudyStats)
          .values({ caseStudyId: targetId, viewCount: 1 })
          .onConflictDoUpdate({
            target: caseStudyStats.caseStudyId,
            set: { viewCount: increment(caseStudyStats.viewCount), updatedAt: sql`now()` },
          });
        return;
      }
      default: {
        const exhaustiveCheck: never = input.arm;
        throw new Error(`Unhandled blueprint arm: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  });

  return { success: true, value: null };
}

// ---------------------------------------------------------------------------
// The toggles
// ---------------------------------------------------------------------------

export type BlueprintToggleVerb = "like" | "upvote" | "save";

export interface BlueprintToggleInput {
  readonly arm: BlueprintEngagementArm;
  readonly verb: BlueprintToggleVerb;
  readonly slug: string;
  readonly userId: string;
  readonly isSet: boolean;
}

/**
 * Which verbs each arm offers, as data rather than as a chain of `if`s.
 *
 * ⚠️ THE ASYMMETRY IS THE CONTRACT, NOT AN OVERSIGHT, and three separate schema comments say so:
 * `showcase_launch_stats` has no `save_count` ("saving is on the TEARDOWN arm of the frontend's
 * contract"), `teardown_stats` has no `upvote_count`, and `case_study_stats` has exactly two
 * counters because that arm "is a numbered lesson with no discussion surface". A column nothing
 * renders is the unverified code the field sweeps exist to catch, so the refusal is a real arm of
 * the error union rather than a silent no-op.
 */
const VERBS_BY_ARM: Readonly<Record<BlueprintEngagementArm, readonly BlueprintToggleVerb[]>> = {
  showcase: ["like", "upvote"],
  teardown: ["like", "save"],
  case_study: ["like"],
};

function armOffersVerb(arm: BlueprintEngagementArm, verb: BlueprintToggleVerb): boolean {
  return VERBS_BY_ARM[arm].includes(verb);
}

/**
 * Sets or clears one viewer's like / upvote / save on one published blueprint.
 *
 * ⚠️ GATED ON ENGAGEABLE (`published` alone), NOT on the read gate. `flagged` means a report
 * stands and `quarantined` means an unresolved rights claim; accruing NEW endorsement on a page the
 * platform is actively withholding is indefensible.
 *
 * Returns the resulting count so a grid renders the server's number rather than guessing at one.
 */
export async function setBlueprintToggle(
  input: BlueprintToggleInput,
): Promise<Result<BlueprintToggleOutcome, BlueprintEngagementError>> {
  if (!armOffersVerb(input.arm, input.verb)) {
    return {
      success: false,
      error: { type: "BLUEPRINT_VERB_NOT_AVAILABLE_ON_ARM", arm: input.arm },
    };
  }

  const targetId = await resolveEngageableBlueprint(input.arm, input.slug);
  if (targetId === null) return { success: false, error: { type: "BLUEPRINT_CONTENT_NOT_FOUND" } };

  /*
   * ⚠️ SIX EXPLICIT BRANCHES RATHER THAN ONE GENERIC HELPER, AND THAT IS THE CHOICE.
   *
   * A `applyToggle(table, targetColumn, counterColumn)` helper is the obvious factoring and it
   * fights Drizzle's types at every call — the insert `values` shape, the `onConflictDoUpdate`
   * `set` key and the `target` are all table-specific, so the generic version needs either a cast
   * (banned by CLAUDE.md §2) or a type parameter per column. Six branches that each read plainly
   * are cheaper than one that needs a paragraph to explain its signature.
   */
  const count = await db.transaction(async (transaction) => {
    switch (input.arm) {
      case "showcase": {
        if (input.verb === "like") {
          const inserted = input.isSet
            ? await transaction
                .insert(showcaseLaunchLike)
                .values({ launchId: targetId, userId: input.userId })
                .onConflictDoNothing()
                .returning({ userId: showcaseLaunchLike.userId })
            : await transaction
                .delete(showcaseLaunchLike)
                .where(
                  and(
                    eq(showcaseLaunchLike.launchId, targetId),
                    eq(showcaseLaunchLike.userId, input.userId),
                  ),
                )
                .returning({ userId: showcaseLaunchLike.userId });
          if (inserted.length > 0) {
            await transaction
              .insert(showcaseLaunchStats)
              .values({ launchId: targetId, likeCount: input.isSet ? 1 : 0 })
              .onConflictDoUpdate({
                target: showcaseLaunchStats.launchId,
                set: {
                  likeCount: input.isSet
                    ? increment(showcaseLaunchStats.likeCount)
                    : decrement(showcaseLaunchStats.likeCount),
                  updatedAt: sql`now()`,
                },
              });
          }
          const [row] = await transaction
            .select({ value: showcaseLaunchStats.likeCount })
            .from(showcaseLaunchStats)
            .where(eq(showcaseLaunchStats.launchId, targetId));
          return row?.value ?? 0;
        }

        const changed = input.isSet
          ? await transaction
              .insert(showcaseLaunchUpvote)
              .values({ launchId: targetId, userId: input.userId })
              .onConflictDoNothing()
              .returning({ userId: showcaseLaunchUpvote.userId })
          : await transaction
              .delete(showcaseLaunchUpvote)
              .where(
                and(
                  eq(showcaseLaunchUpvote.launchId, targetId),
                  eq(showcaseLaunchUpvote.userId, input.userId),
                ),
              )
              .returning({ userId: showcaseLaunchUpvote.userId });
        if (changed.length > 0) {
          await transaction
            .insert(showcaseLaunchStats)
            .values({ launchId: targetId, upvoteCount: input.isSet ? 1 : 0 })
            .onConflictDoUpdate({
              target: showcaseLaunchStats.launchId,
              set: {
                upvoteCount: input.isSet
                  ? increment(showcaseLaunchStats.upvoteCount)
                  : decrement(showcaseLaunchStats.upvoteCount),
                updatedAt: sql`now()`,
              },
            });
        }
        const [upvoteRow] = await transaction
          .select({ value: showcaseLaunchStats.upvoteCount })
          .from(showcaseLaunchStats)
          .where(eq(showcaseLaunchStats.launchId, targetId));
        return upvoteRow?.value ?? 0;
      }

      case "teardown": {
        if (input.verb === "like") {
          const changed = input.isSet
            ? await transaction
                .insert(teardownLike)
                .values({ teardownId: targetId, userId: input.userId })
                .onConflictDoNothing()
                .returning({ userId: teardownLike.userId })
            : await transaction
                .delete(teardownLike)
                .where(
                  and(eq(teardownLike.teardownId, targetId), eq(teardownLike.userId, input.userId)),
                )
                .returning({ userId: teardownLike.userId });
          if (changed.length > 0) {
            await transaction
              .insert(teardownStats)
              .values({ teardownId: targetId, likeCount: input.isSet ? 1 : 0 })
              .onConflictDoUpdate({
                target: teardownStats.teardownId,
                set: {
                  likeCount: input.isSet
                    ? increment(teardownStats.likeCount)
                    : decrement(teardownStats.likeCount),
                  updatedAt: sql`now()`,
                },
              });
          }
          const [row] = await transaction
            .select({ value: teardownStats.likeCount })
            .from(teardownStats)
            .where(eq(teardownStats.teardownId, targetId));
          return row?.value ?? 0;
        }

        const changed = input.isSet
          ? await transaction
              .insert(teardownSave)
              .values({ teardownId: targetId, userId: input.userId })
              .onConflictDoNothing()
              .returning({ userId: teardownSave.userId })
          : await transaction
              .delete(teardownSave)
              .where(
                and(eq(teardownSave.teardownId, targetId), eq(teardownSave.userId, input.userId)),
              )
              .returning({ userId: teardownSave.userId });
        if (changed.length > 0) {
          await transaction
            .insert(teardownStats)
            .values({ teardownId: targetId, saveCount: input.isSet ? 1 : 0 })
            .onConflictDoUpdate({
              target: teardownStats.teardownId,
              set: {
                saveCount: input.isSet
                  ? increment(teardownStats.saveCount)
                  : decrement(teardownStats.saveCount),
                updatedAt: sql`now()`,
              },
            });
        }
        const [saveRow] = await transaction
          .select({ value: teardownStats.saveCount })
          .from(teardownStats)
          .where(eq(teardownStats.teardownId, targetId));
        return saveRow?.value ?? 0;
      }

      case "case_study": {
        const changed = input.isSet
          ? await transaction
              .insert(caseStudyLike)
              .values({ caseStudyId: targetId, userId: input.userId })
              .onConflictDoNothing()
              .returning({ userId: caseStudyLike.userId })
          : await transaction
              .delete(caseStudyLike)
              .where(
                and(
                  eq(caseStudyLike.caseStudyId, targetId),
                  eq(caseStudyLike.userId, input.userId),
                ),
              )
              .returning({ userId: caseStudyLike.userId });
        if (changed.length > 0) {
          await transaction
            .insert(caseStudyStats)
            .values({ caseStudyId: targetId, likeCount: input.isSet ? 1 : 0 })
            .onConflictDoUpdate({
              target: caseStudyStats.caseStudyId,
              set: {
                likeCount: input.isSet
                  ? increment(caseStudyStats.likeCount)
                  : decrement(caseStudyStats.likeCount),
                updatedAt: sql`now()`,
              },
            });
        }
        const [row] = await transaction
          .select({ value: caseStudyStats.likeCount })
          .from(caseStudyStats)
          .where(eq(caseStudyStats.caseStudyId, targetId));
        return row?.value ?? 0;
      }

      default: {
        const exhaustiveCheck: never = input.arm;
        throw new Error(`Unhandled blueprint arm: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  });

  return { success: true, value: { isSet: input.isSet, count } };
}

// ---------------------------------------------------------------------------
// The batched viewer state
// ---------------------------------------------------------------------------

export interface BlueprintViewerStateInput {
  readonly userId: string;
  readonly showcaseSlugs: readonly string[];
  readonly teardownSlugs: readonly string[];
  readonly caseStudySlugs: readonly string[];
}

export interface BlueprintViewerState {
  readonly showcases: Record<string, { readonly hasLiked: boolean; readonly hasUpvoted: boolean }>;
  readonly teardowns: Record<string, { readonly hasLiked: boolean; readonly hasSaved: boolean }>;
  readonly caseStudies: Record<string, { readonly hasLiked: boolean }>;
}

/**
 * What this viewer has already done to a named set of blueprints.
 *
 * ⚠️ ITS OWN AUTHENTICATED ROUTE, RATHER THAN A FIELD ON THE PUBLIC READS. The public reads are
 * BARE — no `requireAuth`, no `attachOptionalUser`, no limiter — and the doc's justification for
 * that is precisely that "the payload is identical for every visitor". Adding `viewerState` there
 * would make them per-viewer, force a session resolve on a page's opening element, and destroy the
 * cacheability the bare design buys. One batched call keeps both properties.
 *
 * KEYED BY SLUG, NOT ID, because that is what the reader's URL and the public payload carry. Ids
 * stay internal.
 */
export async function readBlueprintViewerState(
  input: BlueprintViewerStateInput,
): Promise<BlueprintViewerState> {
  const showcases: Record<string, { hasLiked: boolean; hasUpvoted: boolean }> = {};
  const teardowns: Record<string, { hasLiked: boolean; hasSaved: boolean }> = {};
  const caseStudies: Record<string, { hasLiked: boolean }> = {};

  if (input.showcaseSlugs.length > 0) {
    const rows = await db
      .select({
        slug: showcaseLaunch.publicSlug,
        hasLiked: sql<boolean>`${showcaseLaunchLike.userId} IS NOT NULL`,
        hasUpvoted: sql<boolean>`${showcaseLaunchUpvote.userId} IS NOT NULL`,
      })
      .from(showcaseLaunch)
      .leftJoin(
        showcaseLaunchLike,
        and(
          eq(showcaseLaunchLike.launchId, showcaseLaunch.id),
          eq(showcaseLaunchLike.userId, input.userId),
        ),
      )
      .leftJoin(
        showcaseLaunchUpvote,
        and(
          eq(showcaseLaunchUpvote.launchId, showcaseLaunch.id),
          eq(showcaseLaunchUpvote.userId, input.userId),
        ),
      )
      .where(inArray(showcaseLaunch.publicSlug, [...input.showcaseSlugs]));
    for (const row of rows) {
      if (row.slug === null) continue;
      showcases[row.slug] = { hasLiked: row.hasLiked, hasUpvoted: row.hasUpvoted };
    }
  }

  if (input.teardownSlugs.length > 0) {
    const rows = await db
      .select({
        slug: teardown.slug,
        hasLiked: sql<boolean>`${teardownLike.userId} IS NOT NULL`,
        hasSaved: sql<boolean>`${teardownSave.userId} IS NOT NULL`,
      })
      .from(teardown)
      .leftJoin(
        teardownLike,
        and(eq(teardownLike.teardownId, teardown.id), eq(teardownLike.userId, input.userId)),
      )
      .leftJoin(
        teardownSave,
        and(eq(teardownSave.teardownId, teardown.id), eq(teardownSave.userId, input.userId)),
      )
      .where(inArray(teardown.slug, [...input.teardownSlugs]));
    for (const row of rows) {
      teardowns[row.slug] = { hasLiked: row.hasLiked, hasSaved: row.hasSaved };
    }
  }

  if (input.caseStudySlugs.length > 0) {
    const rows = await db
      .select({
        slug: caseStudy.publicSlug,
        hasLiked: sql<boolean>`${caseStudyLike.userId} IS NOT NULL`,
      })
      .from(caseStudy)
      .leftJoin(
        caseStudyLike,
        and(eq(caseStudyLike.caseStudyId, caseStudy.id), eq(caseStudyLike.userId, input.userId)),
      )
      .where(inArray(caseStudy.publicSlug, [...input.caseStudySlugs]));
    for (const row of rows) {
      if (row.slug === null) continue;
      caseStudies[row.slug] = { hasLiked: row.hasLiked };
    }
  }

  return { showcases, teardowns, caseStudies };
}
