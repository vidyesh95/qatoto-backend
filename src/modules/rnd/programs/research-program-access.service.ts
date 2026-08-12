import { and, eq, isNotNull } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { researchProgram, researchProgramParticipant, user } from "#src/db/schema.js";
import type { Result } from "#src/types/index.js";

/**
 * THE single authorization entry point for every program-scoped route
 * (R_AND_D_BACKEND_STRUCTURE.md §10, §11f). The §10 sibling of
 * `project-membership.service.ts`.
 *
 * WHY A SERVICE AND NOT MIDDLEWARE — the same reason both of its siblings give:
 * middleware cannot return a `Result`, so it cannot participate in the controller's
 * exhaustive error switch. It would have to write a response itself or throw, putting an
 * authorization decision outside the one place that maps domain errors to statuses.
 *
 * HOW THIS DIFFERS FROM `requireProjectRole`, AND WHY IT IS NOT A ROLE LADDER.
 * A project is a closed team with four ranked roles, so authorization there is "are you
 * at or above `maintainer`". A program is OPEN BY DESIGN — thousands of contributors, no
 * ranks, and `research_program_participant.role` is a self-declared statement of HOW
 * someone contributes (researcher, supplier, supporter), not what they may do. Treating
 * it as a ladder would mean a user could grant themselves authority by editing their own
 * participant row, which `PATCH …/contributors/me` explicitly lets them do.
 *
 * So authority on a program comes from exactly three places, and nowhere else:
 *
 *   1. **Anyone signed in** may claim a branch, post, react, report, and log their own
 *      effort. That is what an open program means.
 *   2. **The program's CREATOR** may edit the program and add product opportunities.
 *   3. **A `moderate_content` platform holder** may publish, reject, hide and restore.
 *      That check lives in `platform-role.service.ts` and is called separately, BEFORE
 *      any id is read, so its 403 is not an id oracle.
 *
 * `research_program_participant.role` authorizes NOTHING. If that ever changes, it stops
 * being self-editable in the same commit.
 */

/**
 * The ONE access error, shared by every §10 service union — the §10 analogue of
 * `ProjectAccessError`.
 *
 * Two variants sharing a `type` literal must share a payload or the controller's
 * exhaustive switch narrows to a union and cannot read the field, so every §10 service
 * composes THIS type in rather than declaring its own NOT_FOUND.
 */
export type ProgramAccessError = { type: "NOT_FOUND"; programRef: string };

export type ResearchProgramStatus = (typeof researchProgram.$inferSelect)["status"];

/** A program row the caller has been proven allowed to see. */
export interface ProgramContext {
  readonly programId: string;
  readonly programSlug: string;
  readonly programStatus: ResearchProgramStatus;
  readonly createdByUserId: string | null;
  /** True when the caller created this program — the only ownership this domain has. */
  readonly isCreator: boolean;
}

/**
 * Resolves a program the caller is allowed to READ.
 *
 * A `published` program is visible to everyone, signed in or not. A `pending`,
 * `rejected` or `archived` one is visible ONLY to its creator and to staff, and is a
 * flat `NOT_FOUND` to everyone else — never a 403. A stranger must not be able to
 * enumerate which program slugs have been submitted, and a distinguishable refusal is
 * exactly that enumeration.
 *
 * `isStaff` is passed IN rather than looked up here, because the capability check has to
 * happen before any id is read (`platform-role.service.ts`'s ordering rule) and this
 * function reads an id. Callers that have not proven staff standing pass `false`, which
 * is the safe default.
 */
export async function requireProgramVisible(
  programSlug: string,
  viewerUserId: string | null,
  isStaff = false,
): Promise<Result<ProgramContext, ProgramAccessError>> {
  const [row] = await db
    .select({
      programId: researchProgram.id,
      programSlug: researchProgram.slug,
      programStatus: researchProgram.status,
      createdByUserId: researchProgram.createdByUserId,
    })
    .from(researchProgram)
    .where(eq(researchProgram.slug, programSlug));

  if (!row) {
    return { success: false, error: { type: "NOT_FOUND", programRef: programSlug } };
  }

  const isCreator = viewerUserId !== null && row.createdByUserId === viewerUserId;
  const isPubliclyVisible = row.programStatus === "published" || row.programStatus === "archived";

  // `archived` stays readable: a program that ran and stopped is history, and hiding it
  // would break every link and citation pointing at its papers. It is closed to WRITES
  // instead — see `requireProgramWritable`.
  if (!isPubliclyVisible && !isCreator && !isStaff) {
    return { success: false, error: { type: "NOT_FOUND", programRef: programSlug } };
  }

  return {
    success: true,
    value: {
      programId: row.programId,
      programSlug: row.programSlug,
      programStatus: row.programStatus,
      createdByUserId: row.createdByUserId,
      isCreator,
    },
  };
}

/**
 * Resolves a program the caller may CONTRIBUTE to — claim a branch, upload a paper,
 * post, react, log effort.
 *
 * Adds one rule to {@link requireProgramVisible}: the program must be `published`.
 *
 *   * `pending` — nobody may contribute to a program that has not been reviewed, INCLUDING
 *     its creator. Otherwise a spam program is a working forum that merely lacks an index
 *     entry, and the review gate buys nothing.
 *   * `rejected` / `archived` — closed.
 *
 * A refused write on a program the caller CAN see is a real 409, not a 404: they already
 * know it exists, so there is nothing left to protect and a 404 would just be confusing.
 * That is the same reasoning that makes `requireProgramVisible` collapse its cases and
 * this one not.
 */
export async function requireProgramWritable(
  programSlug: string,
  viewerUserId: string,
  isStaff = false,
): Promise<Result<ProgramContext, ProgramAccessError | ProgramNotWritableError>> {
  const visibleResult = await requireProgramVisible(programSlug, viewerUserId, isStaff);
  if (!visibleResult.success) return visibleResult;

  if (visibleResult.value.programStatus !== "published") {
    return {
      success: false,
      error: { type: "PROGRAM_NOT_PUBLISHED", status: visibleResult.value.programStatus },
    };
  }
  return visibleResult;
}

export type ProgramNotWritableError = {
  type: "PROGRAM_NOT_PUBLISHED";
  status: ResearchProgramStatus;
};

/**
 * Resolves a program the caller OWNS.
 *
 * Returns the same `NOT_FOUND` for "no such program" and "not yours", for the same
 * reason `requireProjectRole` collapses its four cases: a distinguishable refusal lets a
 * stranger confirm a slug exists.
 *
 * Staff are deliberately NOT owners. A moderator may publish, reject, hide and restore —
 * decisions this domain records against their name — but rewriting someone's mission
 * statement is not moderation, and there is no audit event for it because it should not
 * happen.
 */
export async function requireProgramOwner(
  programSlug: string,
  userId: string,
): Promise<Result<ProgramContext, ProgramAccessError>> {
  const visibleResult = await requireProgramVisible(programSlug, userId);
  if (!visibleResult.success) return visibleResult;

  if (!visibleResult.value.isCreator) {
    return { success: false, error: { type: "NOT_FOUND", programRef: programSlug } };
  }
  return visibleResult;
}

/**
 * The caller's participant row, or null.
 *
 * Not an authorization check — see the header note. It exists because effort logs and
 * contribution entries hang off `participantId`, so a write has to resolve one, and
 * because `isViewerParticipant` drives whether the UI offers a join button or an edit
 * one.
 */
export async function findParticipant(
  programId: string,
  userId: string,
): Promise<{ readonly participantId: string } | null> {
  const [row] = await db
    .select({ participantId: researchProgramParticipant.id })
    .from(researchProgramParticipant)
    .where(
      and(
        eq(researchProgramParticipant.programId, programId),
        eq(researchProgramParticipant.userId, userId),
      ),
    );

  return row ?? null;
}

/**
 * The author projection every §10 read embeds: who wrote this, as they are NOW.
 *
 * JOINED from `user`, never copied onto the content row — a denormalized display name
 * drifts the moment someone changes it, which §5's roster note makes the same point
 * about.
 *
 * `locationLabel` is a SELF-SET CLAIM (see the column comment). It travels because §10's
 * discussion renders "Pune, India" under an idea, and it must be rendered as the author's
 * own statement about themselves. Nothing may branch on it.
 */
export interface ProgramAuthorView {
  readonly userId: string | null;
  readonly name: string;
  readonly handle: string | null;
  readonly avatarImageUrl: string | null;
  readonly locationLabel: string | null;
}

/**
 * The columns to select for a {@link ProgramAuthorView}. Applied at the projection
 * boundary so every §10 read spells the author the same way.
 */
export const PROGRAM_AUTHOR_COLUMNS = {
  authorUserId: user.id,
  authorName: user.name,
  authorHandle: user.handle,
  authorAvatarImageUrl: user.image,
  authorLocationLabel: user.locationLabel,
} as const;

/**
 * Folds the selected author columns into one view.
 *
 * A deleted account leaves `set null` FKs behind, so a real row can genuinely have no
 * author. It renders as "Former contributor" rather than as an empty name — the content
 * stays, the attribution honestly does not.
 */
export function toProgramAuthorView(row: {
  readonly authorUserId: string | null;
  readonly authorName: string | null;
  readonly authorHandle: string | null;
  readonly authorAvatarImageUrl: string | null;
  readonly authorLocationLabel: string | null;
}): ProgramAuthorView {
  return {
    userId: row.authorUserId,
    name: row.authorName ?? "Former contributor",
    handle: row.authorHandle,
    avatarImageUrl: row.authorAvatarImageUrl,
    locationLabel: row.authorLocationLabel,
  };
}

/** True when this user holds a staff role at all. Cheap pre-filter for read visibility. */
export async function hasAnyPlatformRole(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.id, userId), isNotNull(user.platformRole)))
    .limit(1);

  return row !== undefined;
}
