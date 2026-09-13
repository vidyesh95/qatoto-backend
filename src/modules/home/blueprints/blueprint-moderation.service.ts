import { and, eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { blueprintModerationAction, caseStudy, teardown } from "#src/db/schema.js";
import {
  actionKindForVerb,
  auditLabelForVerb,
  parseCaseStudyModerationState,
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
      // 1. THE ROW, LOCKED. The lock and the UPDATE's predicate must agree on the source state.
      const rawSnapshot =
        arm === "teardown"
          ? (
              await transaction
                .select({
                  moderationState: teardown.moderationState,
                  authorUserId: teardown.authorUserId,
                })
                .from(teardown)
                .where(eq(teardown.id, input.targetId))
                .for("update")
            )[0]
          : (
              await transaction
                .select({
                  moderationState: caseStudy.moderationState,
                  authorUserId: caseStudy.authorUserId,
                })
                .from(caseStudy)
                .where(eq(caseStudy.id, input.targetId))
                .for("update")
            )[0];

      if (!rawSnapshot) return { kind: "missing" };

      /*
       * ⚠️ NARROWED, NOT CAST. The column's TypeScript type is the whole seven-label enum; only a
       * CHECK narrows it to the four this arm can hold, and TypeScript cannot see a CHECK. A `null`
       * here means somebody widened that CHECK without adding a row to the matrix — which is a
       * condition that should stop the request rather than fall through to a transition nobody
       * wrote.
       */
      const narrowedState =
        arm === "teardown"
          ? parseTeardownModerationState(rawSnapshot.moderationState)
          : parseCaseStudyModerationState(rawSnapshot.moderationState);
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

      // 4. THE MOVE, guarded on the state the lock observed.
      if (arm === "teardown") {
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
      } else {
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
      }

      /*
       * 5. THE AUDIT ENTRY, INSIDE THE TRANSACTION. The chain hashes the row's own fields, so an
       * append after the commit would hash a different history.
       */
      const auditEntry = await appendPlatformAuditEntry(transaction, {
        eventKind: auditLabelForVerb(input.verb),
        actorUserId: input.staff.staffUserId,
        actorRoleSnapshot: input.staff.platformRole,
        actionLabel:
          input.verb === "flag"
            ? "Flagged a published blueprint"
            : input.verb === "quarantine"
              ? "Quarantined a published teardown"
              : "Restored a blueprint to published",
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
        teardownId: arm === "teardown" ? input.targetId : null,
        caseStudyId: arm === "case_study" ? input.targetId : null,
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
