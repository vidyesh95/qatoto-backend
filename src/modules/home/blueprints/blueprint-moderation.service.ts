import { and, eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { blueprintModerationAction, caseStudy, showcaseLaunch, teardown } from "#src/db/schema.js";
import {
  actionKindForVerb,
  auditLabelForVerb,
  parseCaseStudyModerationState,
  parseShowcaseLaunchModerationState,
  parseTeardownModerationState,
  resolveBlueprintTransition,
} from "#src/modules/home/blueprints/blueprint-moderation-transitions.js";
import type {
  BlueprintModerationArm,
  BlueprintModerationState,
  BlueprintModerationVerb,
} from "#src/modules/home/blueprints/blueprint-moderation-transitions.js";
import { buildErrorWithoutQueryParameters } from "#src/modules/home/blueprints/blueprint-write-errors.js";
import { appendPlatformAuditEntry } from "#src/modules/platform/audit/platform-audit.service.js";
import type { PlatformStaffContext } from "#src/modules/platform/roles/platform-role.service.js";
import type { Result } from "#src/types/index.js";

/**
 * `flag`, `quarantine` and `restore` — the three verbs that act on a PUBLISHED blueprint.
 *
 * ⚠️ A DIFFERENT OBJECT FROM `/:submissionId/moderate`. That route decides a SUBMISSION: publish it
 * or send it back. These act on a row that is already public — and on the teardown arm that is
 * literally a different table with a different id, which is why these routes are addressed by the
 * published row's id rather than by a submission's.
 *
 * ⚠️ `teardown_submission.moderation_state` IS NEVER TOUCHED BY ANY OF THESE. Blueprints doc §4:
 * "the state comes from the TEARDOWN once one exists, by a `COALESCE` over the join… the
 * alternative is a second state machine writing back into `teardown_submission`." So
 * `/teardowns/mine` picks a flag up for free, and `publicSlug` — which that list COMPUTES from the
 * state rather than projecting raw — stops rendering a "View the page" link with nothing extra
 * written anywhere.
 *
 * ⚠️ THE AUDIT PAYLOAD IS IDS AND FLAGS ONLY, AND `detailNote` IS DELIBERATELY UNUSED.
 * `buildHashDocument` hashes `detailNote` into a chain that is hash-linked and kept forever, and a
 * rights-claim note names a manufacturer and one party's account of a private permission.
 * `user-reports.service.ts` passes `detailNote`; this file does not, and the divergence is a
 * decision rather than an oversight. The note the author is owed lives on
 * `blueprint_moderation_action.reason_note`, where an erasure can reach it.
 */

export type BlueprintModerationError =
  | { readonly type: "BLUEPRINT_CONTENT_NOT_FOUND" }
  | { readonly type: "BLUEPRINT_SELF_MODERATION_FORBIDDEN" }
  | {
      readonly type: "BLUEPRINT_ALREADY_IN_STATE";
      readonly moderationState: BlueprintModerationState;
    }
  | {
      readonly type: "BLUEPRINT_NOT_PUBLIC_YET";
      readonly moderationState: BlueprintModerationState;
    }
  | {
      readonly type: "BLUEPRINT_TRANSITION_NOT_AVAILABLE";
      readonly verb: BlueprintModerationVerb;
      readonly arm: BlueprintModerationArm;
      readonly moderationState: BlueprintModerationState;
    };

export interface BlueprintModerationView {
  readonly targetId: string;
  readonly targetKind: BlueprintModerationArm;
  readonly moderationState: BlueprintModerationState;
  readonly decidedAt: Date;
}

interface ApplyVerbInput {
  readonly targetId: string;
  readonly verb: BlueprintModerationVerb;
  readonly reasonNote: string;
  readonly staff: PlatformStaffContext;
}

/** Everything the transaction needs to know about the row it is about to move. */
interface TargetSnapshot {
  readonly moderationState: BlueprintModerationState;
  readonly authorUserId: string | null;
}

/** The same local alias `teardown-moderation.service.ts` uses for a transaction handle. */
type DatabaseExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The locked row, whichever arm it lives on.
 *
 * ⚠️ EVERY ARM-SHAPED BRANCH IN THIS FILE IS A `switch` WITH A `never` DEFAULT. The two-arm version
 * of this code used ternaries, which are the one shape that does NOT break when an arm is added:
 * `arm === "teardown" ? a : b` keeps compiling and silently sends the new arm down the `b` branch.
 * On this path that means locking the wrong table, narrowing against the wrong CHECK and then
 * UPDATING a row nobody asked about. The `never` is what turns a fourth arm into a build failure.
 */
async function selectLockedSnapshot(
  transaction: DatabaseExecutor,
  arm: BlueprintModerationArm,
  targetId: string,
): Promise<{ moderationState: string; authorUserId: string | null } | undefined> {
  switch (arm) {
    case "teardown":
      return (
        await transaction
          .select({
            moderationState: teardown.moderationState,
            authorUserId: teardown.authorUserId,
          })
          .from(teardown)
          .where(eq(teardown.id, targetId))
          .for("update")
      )[0];
    case "case_study":
      return (
        await transaction
          .select({
            moderationState: caseStudy.moderationState,
            authorUserId: caseStudy.authorUserId,
          })
          .from(caseStudy)
          .where(eq(caseStudy.id, targetId))
          .for("update")
      )[0];
    case "showcase":
      return (
        await transaction
          .select({
            moderationState: showcaseLaunch.moderationState,
            authorUserId: showcaseLaunch.authorUserId,
          })
          .from(showcaseLaunch)
          .where(eq(showcaseLaunch.id, targetId))
          .for("update")
      )[0];
    default: {
      const exhaustiveCheck: never = arm;
      throw new Error(`Unhandled moderation arm: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/** Narrows the seven-label column against the arm's own CHECK. `null` means the matrix is stale. */
function narrowModerationStateForArm(
  arm: BlueprintModerationArm,
  rawModerationState: string,
): BlueprintModerationState | null {
  switch (arm) {
    case "teardown":
      return parseTeardownModerationState(rawModerationState);
    case "case_study":
      return parseCaseStudyModerationState(rawModerationState);
    case "showcase":
      return parseShowcaseLaunchModerationState(rawModerationState);
    default: {
      const exhaustiveCheck: never = arm;
      throw new Error(`Unhandled moderation arm: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * The one target column this arm sets, and the two it explicitly nulls.
 *
 * ⚠️ RETURNS ALL THREE KEYS, ALWAYS. `blueprint_moderation_action_target_ck` counts non-nulls, so
 * an omitted key and an explicit `null` are the same row — but they are NOT the same diff. Writing
 * every column makes the two that stay empty visible at the call site, which is what stops a
 * fourth arm being added to the enum while one of these quietly keeps its default.
 */
function targetColumnsForArm(
  arm: BlueprintModerationArm,
  targetId: string,
): { teardownId: string | null; caseStudyId: string | null; showcaseLaunchId: string | null } {
  switch (arm) {
    case "teardown":
      return { teardownId: targetId, caseStudyId: null, showcaseLaunchId: null };
    case "case_study":
      return { teardownId: null, caseStudyId: targetId, showcaseLaunchId: null };
    case "showcase":
      return { teardownId: null, caseStudyId: null, showcaseLaunchId: targetId };
    default: {
      const exhaustiveCheck: never = arm;
      throw new Error(`Unhandled moderation arm: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * The audit chain's human-readable label.
 *
 * ⚠️ VERB-SCOPED, NOT ARM-SCOPED, WHICH IS WHY THE QUARANTINE LINE MAY NAME A TEARDOWN. Quarantine
 * is teardown-only in three independent places, so "Quarantined a published teardown" is a fact
 * about the only arm that can reach this label rather than an assumption about the caller. It was
 * a nested ternary, which hid that reasoning behind a shape that would have kept compiling if
 * quarantine ever widened; a `switch` makes the claim explicit and the widening loud.
 */
function describeVerbForAudit(verb: BlueprintModerationVerb): string {
  switch (verb) {
    case "flag":
      return "Flagged a published blueprint";
    case "quarantine":
      return "Quarantined a published teardown";
    case "restore":
      return "Restored a blueprint to published";
    default: {
      const exhaustiveCheck: never = verb;
      throw new Error(`Unhandled moderation verb: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

type TransactionOutcome =
  | { readonly kind: "missing" }
  | { readonly kind: "self_moderation" }
  | { readonly kind: "already_in_state"; readonly moderationState: BlueprintModerationState }
  | { readonly kind: "not_public_yet"; readonly moderationState: BlueprintModerationState }
  | { readonly kind: "already_published"; readonly moderationState: BlueprintModerationState }
  | {
      readonly kind: "not_available";
      readonly moderationState: BlueprintModerationState;
    }
  | {
      readonly kind: "applied";
      readonly nextState: BlueprintModerationState;
      readonly decidedAt: Date;
    };

function toResult(
  arm: BlueprintModerationArm,
  verb: BlueprintModerationVerb,
  targetId: string,
  outcome: TransactionOutcome,
): Result<BlueprintModerationView, BlueprintModerationError> {
  switch (outcome.kind) {
    case "missing":
      return { success: false, error: { type: "BLUEPRINT_CONTENT_NOT_FOUND" } };
    case "self_moderation":
      return { success: false, error: { type: "BLUEPRINT_SELF_MODERATION_FORBIDDEN" } };
    case "already_in_state":
      return {
        success: false,
        error: { type: "BLUEPRINT_ALREADY_IN_STATE", moderationState: outcome.moderationState },
      };
    case "not_public_yet":
      return {
        success: false,
        error: { type: "BLUEPRINT_NOT_PUBLIC_YET", moderationState: outcome.moderationState },
      };
    /*
     * ⚠️ `already_published`, `quarantine_outranks_flag` AND `not_available` ALL LAND ON ONE ERROR
     * ARM, and they carry the verb and the state so the message can be specific. They are one
     * class — "that verb does not apply to this row as it stands" — and splitting them into three
     * 409s with three messages would ask a moderator to learn a taxonomy instead of reading a
     * sentence.
     */
    case "already_published":
    case "not_available":
      return {
        success: false,
        error: {
          type: "BLUEPRINT_TRANSITION_NOT_AVAILABLE",
          verb,
          arm,
          moderationState: outcome.moderationState,
        },
      };
    case "applied":
      return {
        success: true,
        value: {
          targetId,
          targetKind: arm,
          moderationState: outcome.nextState,
          decidedAt: outcome.decidedAt,
        },
      };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled moderation outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

async function applyVerb(
  arm: BlueprintModerationArm,
  input: ApplyVerbInput,
): Promise<Result<BlueprintModerationView, BlueprintModerationError>> {
  let outcome: TransactionOutcome;

  try {
    outcome = await db.transaction(async (transaction): Promise<TransactionOutcome> => {
      /*
       * 1. THE ROW, LOCKED. The lock and the UPDATE's predicate must agree on the source state.
       *
       * ⚠️ A `switch` WITH A `never` DEFAULT, NEVER A TERNARY. This was
       * `arm === "teardown" ? ... : ...` while there were two arms, and a binary ternary does not
       * fail to compile when a third arrives — it silently routes the new arm into the ELSE
       * branch, which here means locking, narrowing and then UPDATING the wrong row in the wrong
       * table. The compiler cannot catch that; only this shape can.
       */
      const rawSnapshot = await selectLockedSnapshot(transaction, arm, input.targetId);

      if (!rawSnapshot) return { kind: "missing" };

      /*
       * ⚠️ NARROWED, NOT CAST. The column's TypeScript type is the whole seven-label enum; only a
       * CHECK narrows it to the four this arm can hold, and TypeScript cannot see a CHECK. A `null`
       * here means somebody widened that CHECK without adding a row to the matrix — which is a
       * condition that should stop the request rather than fall through to a transition nobody
       * wrote.
       */
      const narrowedState = narrowModerationStateForArm(arm, rawSnapshot.moderationState);
      if (narrowedState === null) {
        throw new Error(
          `${arm} ${input.targetId} holds moderation state "${rawSnapshot.moderationState}", which the transition matrix does not list. Widen the matrix before widening the CHECK.`,
        );
      }

      const snapshot: TargetSnapshot = {
        moderationState: narrowedState,
        authorUserId: rawSnapshot.authorUserId,
      };

      /*
       * 2. SELF-MODERATION, REFUSED. The same rule `decideTeardown` applies at publish: a
       * moderator must not quarantine their own survey out of a rights dispute they are party to.
       * A seeded row carries a NULL author and is moderable by anybody, which is correct — nobody
       * is party to a fixture.
       */
      if (snapshot.authorUserId !== null && snapshot.authorUserId === input.staff.staffUserId) {
        return { kind: "self_moderation" };
      }

      // 3. THE MATRIX. Every refusal is a named arm; nothing is decided inline here.
      const transition = resolveBlueprintTransition(arm, snapshot.moderationState, input.verb);
      switch (transition.kind) {
        case "already_in_state":
          return { kind: "already_in_state", moderationState: snapshot.moderationState };
        case "not_public_yet":
          return { kind: "not_public_yet", moderationState: snapshot.moderationState };
        case "already_published":
        case "quarantine_outranks_flag":
        case "not_available_on_arm":
          return { kind: "not_available", moderationState: snapshot.moderationState };
        case "allowed":
          break;
        default: {
          const exhaustiveCheck: never = transition;
          throw new Error(`Unhandled transition: ${JSON.stringify(exhaustiveCheck)}`);
        }
      }

      const nextState = transition.nextState;
      const decidedAt = new Date();

      /*
       * 4. THE MOVE, guarded on the state the lock observed.
       *
       * The per-arm `nextState` re-checks are not redundant with the matrix. They are what lets
       * the column's narrow type be honest at the point of the write: the matrix decides the
       * transition, and these prove the destination is one this arm's CHECK admits, so a matrix
       * edit that outran a CHECK fails here rather than as a 23514 with no explanation.
       */
      switch (arm) {
        case "teardown": {
          if (nextState !== "published" && nextState !== "flagged" && nextState !== "quarantined") {
            throw new Error(`A teardown cannot move to ${nextState}`);
          }
          await transaction
            .update(teardown)
            .set({ moderationState: nextState })
            .where(
              and(
                eq(teardown.id, input.targetId),
                eq(teardown.moderationState, snapshot.moderationState),
              ),
            );
          break;
        }
        case "case_study": {
          if (nextState !== "published" && nextState !== "flagged") {
            throw new Error(`A case study cannot move to ${nextState}`);
          }
          await transaction
            .update(caseStudy)
            .set({ moderationState: nextState })
            .where(
              and(
                eq(caseStudy.id, input.targetId),
                eq(caseStudy.moderationState, snapshot.moderationState),
              ),
            );
          break;
        }
        case "showcase": {
          if (nextState !== "published" && nextState !== "flagged") {
            throw new Error(`A showcase launch cannot move to ${nextState}`);
          }
          await transaction
            .update(showcaseLaunch)
            .set({ moderationState: nextState })
            .where(
              and(
                eq(showcaseLaunch.id, input.targetId),
                eq(showcaseLaunch.moderationState, snapshot.moderationState),
              ),
            );
          break;
        }
        default: {
          const exhaustiveCheck: never = arm;
          throw new Error(`Unhandled moderation arm: ${JSON.stringify(exhaustiveCheck)}`);
        }
      }

      /*
       * 5. THE AUDIT ENTRY, INSIDE THE TRANSACTION. The chain hashes the row's own fields, so an
       * append after the commit would hash a different history.
       */
      const auditEntry = await appendPlatformAuditEntry(transaction, {
        eventKind: auditLabelForVerb(input.verb),
        actorUserId: input.staff.staffUserId,
        actorRoleSnapshot: input.staff.platformRole,
        actionLabel: describeVerbForAudit(input.verb),
        targetLabel: `${arm} ${input.targetId}`,
        // ⚠️ IDS AND FLAGS ONLY. `hasReasonNote`, never the note. See the file docblock.
        payload: {
          targetKind: arm,
          targetId: input.targetId,
          fromModerationState: snapshot.moderationState,
          toModerationState: nextState,
          hasReasonNote: true,
        },
        occurredAt: decidedAt,
      });

      // 6. The decision record, which is where the note lives.
      await transaction.insert(blueprintModerationAction).values({
        actionKind: actionKindForVerb(input.verb),
        targetKind: arm,
        ...targetColumnsForArm(arm, input.targetId),
        moderatorUserId: input.staff.staffUserId,
        moderatorRoleSnapshot: input.staff.platformRole,
        reasonNote: input.reasonNote,
        auditEntryId: auditEntry.id,
      });

      return { kind: "applied", nextState, decidedAt };
    });
  } catch (error: unknown) {
    /*
     * ⚠️ NO DATABASE ERROR MAY REACH THE LOGGER. `DrizzleQueryError`'s message carries every bound
     * parameter and `errorFields` copies it into `errorMessage` — and this transaction binds the
     * moderator's reason note and, on the case-study arm, touches a row whose evidence can hold a
     * company name its writer withheld from readers. Re-thrown with the SQLSTATE alone and
     * deliberately NO `cause`, because a logger that walks `cause` undoes all of it.
     */
    throw buildErrorWithoutQueryParameters(
      error,
      "blueprint moderation verb",
      "they include a moderator's free-text reason note and a case study whose evidence may carry a withheld company name",
    );
  }

  return toResult(arm, input.verb, input.targetId, outcome);
}

export async function applyTeardownModerationVerb(
  input: ApplyVerbInput,
): Promise<Result<BlueprintModerationView, BlueprintModerationError>> {
  return applyVerb("teardown", input);
}

export async function applyCaseStudyModerationVerb(
  input: ApplyVerbInput,
): Promise<Result<BlueprintModerationView, BlueprintModerationError>> {
  return applyVerb("case_study", input);
}

/**
 * ⚠️ `flag` AND `restore` ONLY — `quarantine` answers `not_available_on_arm`, like a case study's.
 * The two arms reach that refusal for different reasons, and the difference is worth keeping in
 * mind: a case study has no files, while a showcase HAS them and they are its own maker's.
 */
export async function applyShowcaseLaunchModerationVerb(
  input: ApplyVerbInput,
): Promise<Result<BlueprintModerationView, BlueprintModerationError>> {
  return applyVerb("showcase", input);
}
