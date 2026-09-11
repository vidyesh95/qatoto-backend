import { and, asc, eq, gt, inArray, or, type SQL } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  SHOWCASE_LAUNCH_RESERVED_SLUGS,
  showcaseLaunch,
  showcaseLaunchTeamMember,
  showcaseLaunchWriteUpImage,
  user,
} from "#src/db/schema.js";
import { encodeInstantCursor, type InstantCursor } from "#src/lib/instant-cursor.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import type { ModerateShowcaseLaunchInput } from "#src/modules/home/blueprints/showcase-launch.schemas.js";
import { appendPlatformAuditEntry } from "#src/modules/platform/audit/platform-audit.service.js";
import type {
  PlatformAccessError,
  PlatformStaffContext,
} from "#src/modules/platform/roles/platform-role.service.js";
import { slugifyProgramTitle } from "#src/modules/rnd/programs/research-programs.service.js";
import type { Result } from "#src/types/index.js";

/**
 * The showcase launch review queue and the decision on one launch.
 *
 * THE CAPABILITY CHECK IS THE CALLER'S JOB, and it has already happened. Every function takes a
 * `PlatformStaffContext` — the proof, not a user id — so neither can be called without standing
 * having been proven first, capability before any id is read (`platform-role.service.ts`).
 *
 * THE AUDIT ENTRY CARRIES IDS ONLY. The chain is hash-linked and kept forever, and a moderator's
 * note to a maker is correspondence, not an accountability fact; the entry records THAT a note was
 * sent, and the note itself lives on the launch row where erasure can reach it.
 */

type DatabaseExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ShowcaseLaunchModerationError =
  | PlatformAccessError
  | { readonly type: "SHOWCASE_LAUNCH_NOT_FOUND" }
  | { readonly type: "SHOWCASE_LAUNCH_SELF_MODERATION_FORBIDDEN" }
  | {
      readonly type: "SHOWCASE_LAUNCH_ALREADY_DECIDED";
      readonly moderationState: (typeof showcaseLaunch.$inferSelect)["moderationState"];
    };

/** One launch as a moderator reads it: everything the maker sent, and who sent it. */
export interface ShowcaseReviewItemView {
  readonly submissionId: string;
  readonly submittedAt: Date;
  /** `handle` is nullable because an account's handle is. */
  readonly author: { readonly displayName: string; readonly handle: string | null };
  readonly acceptedLaunchStatementIds: readonly string[];
  readonly title: string;
  readonly tagline: string;
  readonly summary: string;
  readonly writeUp: string | null;
  readonly writeUpImages: readonly {
    readonly url: string;
    readonly widthPx: number;
    readonly heightPx: number;
    readonly blurDataUrl: string;
  }[];
  readonly headingImageUrl: string;
  readonly launchedAt: Date;
  readonly difficulty: (typeof showcaseLaunch.$inferSelect)["difficulty"];
  readonly billOfMaterialsCostRange: {
    readonly minimumInCents: number;
    readonly maximumInCents: number;
    readonly currency: string;
  } | null;
  readonly tags: readonly string[];
  readonly team: readonly {
    readonly displayName: string;
    readonly handle: string;
    readonly role: string;
  }[];
  readonly builtFromBlueprintSlug: string | null;
  readonly callToAction: { readonly label: string; readonly url: string } | null;
}

export interface ShowcaseReviewQueuePage {
  readonly items: readonly ShowcaseReviewItemView[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

export interface ShowcaseModerationDecisionView {
  readonly submissionId: string;
  readonly moderationState: "published" | "rejected";
  readonly publicSlug: string | null;
  readonly decidedAt: Date;
}

/**
 * Launches waiting for a decision, OLDEST FIRST.
 *
 * Oldest first for the reason every queue here is: newest-first starves its own tail, and the
 * launch that has waited longest is the one owed an answer. The team and the write-up images
 * arrive in one `IN` query each rather than one query per launch.
 */
export async function listShowcaseReviewQueue(input: {
  readonly staff: PlatformStaffContext;
  readonly limit: number;
  readonly cursor: InstantCursor | undefined;
}): Promise<ShowcaseReviewQueuePage> {
  const conditions: SQL[] = [eq(showcaseLaunch.moderationState, "pending_review")];
  if (input.cursor !== undefined) {
    const { instant, id } = input.cursor;
    // Ascending, so `>`.
    const afterCursorCondition = or(
      gt(showcaseLaunch.createdAt, instant),
      and(eq(showcaseLaunch.createdAt, instant), gt(showcaseLaunch.id, id)),
    );
    if (afterCursorCondition !== undefined) conditions.push(afterCursorCondition);
  }

  const launchRows = await db
    .select({
      launch: showcaseLaunch,
      authorDisplayName: user.name,
      authorHandle: user.handle,
    })
    .from(showcaseLaunch)
    .innerJoin(user, eq(user.id, showcaseLaunch.authorUserId))
    .where(and(...conditions))
    .orderBy(asc(showcaseLaunch.createdAt), asc(showcaseLaunch.id))
    .limit(input.limit + 1);

  const hasMore = launchRows.length > input.limit;
  const pageRows = hasMore ? launchRows.slice(0, input.limit) : launchRows;
  const launchIds = pageRows.map((launchRow) => launchRow.launch.id);

  const [teamRows, imageRows] =
    launchIds.length === 0
      ? [[], []]
      : await Promise.all([
          db
            .select()
            .from(showcaseLaunchTeamMember)
            .where(inArray(showcaseLaunchTeamMember.launchId, launchIds))
            .orderBy(
              asc(showcaseLaunchTeamMember.launchId),
              asc(showcaseLaunchTeamMember.position),
            ),
          db
            .select()
            .from(showcaseLaunchWriteUpImage)
            .where(inArray(showcaseLaunchWriteUpImage.launchId, launchIds))
            .orderBy(asc(showcaseLaunchWriteUpImage.createdAt), asc(showcaseLaunchWriteUpImage.id)),
        ]);

  const lastRow = pageRows.at(-1);

  return {
    items: pageRows.map(({ launch, authorDisplayName, authorHandle }) => {
      const hasCostRange =
        launch.billOfMaterialsMinimumCents !== null &&
        launch.billOfMaterialsMaximumCents !== null &&
        launch.billOfMaterialsCurrency !== null;
      return {
        submissionId: launch.id,
        submittedAt: launch.createdAt,
        author: { displayName: authorDisplayName, handle: authorHandle },
        acceptedLaunchStatementIds: launch.acceptedLaunchStatementIds,
        title: launch.title,
        tagline: launch.tagline,
        summary: launch.summary,
        writeUp: launch.writeUp,
        writeUpImages: imageRows
          .filter((imageRow) => imageRow.launchId === launch.id)
          .map((imageRow) => ({
            url: imageRow.url,
            widthPx: imageRow.widthPx,
            heightPx: imageRow.heightPx,
            blurDataUrl: imageRow.blurDataUrl,
          })),
        headingImageUrl: launch.headingImageUrl,
        launchedAt: launch.launchedAt,
        difficulty: launch.difficulty,
        billOfMaterialsCostRange:
          hasCostRange &&
          launch.billOfMaterialsMinimumCents !== null &&
          launch.billOfMaterialsMaximumCents !== null &&
          launch.billOfMaterialsCurrency !== null
            ? {
                minimumInCents: launch.billOfMaterialsMinimumCents,
                maximumInCents: launch.billOfMaterialsMaximumCents,
                currency: launch.billOfMaterialsCurrency,
              }
            : null,
        tags: launch.tags,
        team: teamRows
          .filter((teamRow) => teamRow.launchId === launch.id)
          .map((teamRow) => ({
            displayName: teamRow.displayName,
            handle: teamRow.handle,
            role: teamRow.role,
          })),
        builtFromBlueprintSlug: launch.builtFromBlueprintSlug,
        callToAction:
          launch.callToActionLabel !== null && launch.callToActionUrl !== null
            ? { label: launch.callToActionLabel, url: launch.callToActionUrl }
            : null,
      };
    }),
    page: {
      nextCursor:
        hasMore && lastRow
          ? encodeInstantCursor({ instant: lastRow.launch.createdAt, id: lastRow.launch.id })
          : null,
      hasMore,
    },
  };
}

/**
 * The public address a published launch gets, before any collision suffix.
 *
 * A title of pure punctuation or emoji slugifies to nothing, and a title that slugifies to a
 * reserved word would be shadowed by the literal route at that address; both fall back to an
 * address derived from the launch id, which is ugly and always usable.
 */
function buildLaunchSlugBase(title: string, launchId: string): string {
  const titleSlug = slugifyProgramTitle(title);
  const isReservedSlug = SHOWCASE_LAUNCH_RESERVED_SLUGS.some(
    (reservedSlug) => reservedSlug === titleSlug,
  );
  if (titleSlug.length < 3 || isReservedSlug) {
    return `launch-${launchId.replaceAll("-", "").slice(0, 8)}`;
  }
  return titleSlug;
}

/**
 * Publishes the launch under the first free slug.
 *
 * EACH ATTEMPT IN ITS OWN SAVEPOINT. A failed statement aborts the whole transaction in Postgres,
 * so a bare try/catch around a colliding update would leave every later statement — including the
 * audit append — failing with `25P02`. Drizzle's nested `transaction` is SAVEPOINT / ROLLBACK TO
 * SAVEPOINT, which keeps the outer transaction usable.
 *
 * `-2` through `-11`, then an id suffix that cannot collide with another title's base.
 */
async function publishUnderFreeSlug(
  tx: DatabaseExecutor,
  launch: { readonly id: string; readonly title: string },
  decision: {
    readonly reviewedByUserId: string;
    readonly reviewedAt: Date;
    readonly note: string | null;
  },
): Promise<string> {
  const baseSlug = buildLaunchSlugBase(launch.title, launch.id);
  const candidateSlugs = [
    baseSlug,
    ...Array.from(
      { length: 10 },
      (_unused, suffixIndex) => `${baseSlug}-${String(suffixIndex + 2)}`,
    ),
    `${baseSlug}-${launch.id.replaceAll("-", "").slice(0, 8)}`,
  ];

  for (const candidateSlug of candidateSlugs) {
    try {
      await tx.transaction(async (savepoint) => {
        await savepoint
          .update(showcaseLaunch)
          .set({
            moderationState: "published",
            reviewedByUserId: decision.reviewedByUserId,
            reviewedAt: decision.reviewedAt,
            moderatorNote: decision.note,
            publicSlug: candidateSlug,
          })
          .where(
            and(
              eq(showcaseLaunch.id, launch.id),
              eq(showcaseLaunch.moderationState, "pending_review"),
            ),
          );
      });
      return candidateSlug;
    } catch (updateError: unknown) {
      if (!isUniqueViolation(updateError)) throw updateError;
      // Taken — try the next candidate.
    }
  }

  // Twelve collisions on one launch means something is generating them, not a coincidence.
  throw new Error(`publishUnderFreeSlug: every slug candidate for launch ${launch.id} was taken`);
}

/**
 * Publishes a launch or sends it back.
 *
 * `FOR UPDATE`, then three refusals in a fixed order: no such launch (404), the moderator posted it
 * (403), it is already decided (409). The update ALSO guards on `pending_review` in its WHERE, so
 * the lock and the predicate agree on what "undecided" means.
 */
export async function decideShowcaseLaunch(input: {
  readonly submissionId: string;
  readonly decision: ModerateShowcaseLaunchInput;
  readonly staff: PlatformStaffContext;
}): Promise<Result<ShowcaseModerationDecisionView, ShowcaseLaunchModerationError>> {
  // A published note that trims to nothing is no note. A rejection's note is already non-empty.
  const moderatorNote =
    input.decision.moderatorNote === null || input.decision.moderatorNote === ""
      ? null
      : input.decision.moderatorNote;

  const outcome = await db.transaction(async (tx) => {
    const [existingLaunch] = await tx
      .select({
        id: showcaseLaunch.id,
        title: showcaseLaunch.title,
        authorUserId: showcaseLaunch.authorUserId,
        moderationState: showcaseLaunch.moderationState,
      })
      .from(showcaseLaunch)
      .where(eq(showcaseLaunch.id, input.submissionId))
      .for("update");

    if (!existingLaunch) return { kind: "missing" } as const;
    if (existingLaunch.authorUserId === input.staff.staffUserId) {
      return { kind: "self_moderation" } as const;
    }
    if (existingLaunch.moderationState !== "pending_review") {
      return { kind: "already_decided", moderationState: existingLaunch.moderationState } as const;
    }

    const decidedAt = new Date();
    let publicSlug: string | null = null;

    if (input.decision.decision === "published") {
      publicSlug = await publishUnderFreeSlug(tx, existingLaunch, {
        reviewedByUserId: input.staff.staffUserId,
        reviewedAt: decidedAt,
        note: moderatorNote,
      });
    } else {
      await tx
        .update(showcaseLaunch)
        .set({
          moderationState: "rejected",
          reviewedByUserId: input.staff.staffUserId,
          reviewedAt: decidedAt,
          moderatorNote,
        })
        .where(
          and(
            eq(showcaseLaunch.id, existingLaunch.id),
            eq(showcaseLaunch.moderationState, "pending_review"),
          ),
        );
    }

    await appendPlatformAuditEntry(tx, {
      eventKind:
        input.decision.decision === "published"
          ? "showcase_launch_published"
          : "showcase_launch_rejected",
      actorUserId: input.staff.staffUserId,
      actorRoleSnapshot: input.staff.platformRole,
      actionLabel:
        input.decision.decision === "published"
          ? "Published a showcase launch"
          : "Sent a showcase launch back to its maker",
      targetLabel: `showcase launch ${existingLaunch.id}`,
      // IDS AND FLAGS ONLY — see the file header.
      payload: {
        launchId: existingLaunch.id,
        decision: input.decision.decision,
        hasModeratorNote: moderatorNote !== null,
      },
      occurredAt: decidedAt,
    });

    return {
      kind: "decided",
      moderationState: input.decision.decision,
      publicSlug,
      decidedAt,
    } as const;
  });

  switch (outcome.kind) {
    case "missing":
      return { success: false, error: { type: "SHOWCASE_LAUNCH_NOT_FOUND" } };
    case "self_moderation":
      return { success: false, error: { type: "SHOWCASE_LAUNCH_SELF_MODERATION_FORBIDDEN" } };
    case "already_decided":
      return {
        success: false,
        error: {
          type: "SHOWCASE_LAUNCH_ALREADY_DECIDED",
          moderationState: outcome.moderationState,
        },
      };
    case "decided":
      return {
        success: true,
        value: {
          submissionId: input.submissionId,
          moderationState: outcome.moderationState,
          publicSlug: outcome.publicSlug,
          decidedAt: outcome.decidedAt,
        },
      };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled moderation outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
