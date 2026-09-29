import { z } from "zod";

const BLUEPRINT_MODERATION_REASON_NOTE_MAXIMUM_CHARACTERS = 2000;

const ReasonNoteSchema = z
  .string()
  .trim()
  .min(1, "Say why. This is the record of the decision.")
  .max(
    BLUEPRINT_MODERATION_REASON_NOTE_MAXIMUM_CHARACTERS,
    `Keep the note under ${String(BLUEPRINT_MODERATION_REASON_NOTE_MAXIMUM_CHARACTERS)} characters.`,
  );

/**
 * The body of `POST /blueprints/admin/{teardowns,case-studies,showcases}/:id/moderation-state`.
 *
 * A DISCRIMINATED UNION ON `verb`, so the controller's switch is exhaustive over the three and a
 * fourth verb is a compile error rather than a silent fall-through.
 *
 * ⚠️ `reasonNote` IS REQUIRED ON ALL THREE ARMS, INCLUDING `restore`, and that is not symmetry for
 * its own sake. `blueprint_moderation_action.reason_note` is NOT NULL, and §3.7's reasoning for
 * the mandatory rejection note applies harder here: a restore OVERTURNS ANOTHER MODERATOR'S
 * QUARANTINE, and the record of why is the only thing that stops the pair being re-litigated
 * silently.
 *
 * ⚠️ THE NOTE NEVER REACHES THE AUDIT CHAIN. It is stored on the action row, where an erasure can
 * reach it; the chain gets `hasReasonNote: true` and nothing else. See
 * `blueprint-moderation.service.ts`.
 *
 * ⚠️ `reportId` IS NULLABLE, AND IT ARRIVED EXACTLY AS THIS BLOCK PREDICTED IT WOULD. The note it
 * replaces read: "The primary quarantine path is an EMAILED rights claim — blueprints doc §3.7:
 * 'nothing posts to Qatoto, by that flow's own explicit decision' — so a required report id would
 * make the commonest case unexpressible. When a reader report intake lands it adds a nullable one
 * here rather than changing this contract." That is what this is. **NULL is the ordinary case**,
 * not a degraded one: a moderator acting on an email, a routine sweep, or their own reading of a
 * page passes nothing, and the verb behaves exactly as it did before this field existed.
 *
 * ⚠️ SUPPLYING ONE DOES NOT LET A REPORT MOVE A STATE. The moderator still chose the verb; the id
 * only says WHICH open complaint this decision answers, so the reporter's own list can stop
 * showing `open` forever. Blueprints doc §10.1's three rules are untouched — nothing here counts
 * reports, and no threshold exists to trip.
 *
 * ⚠️ `.default(null)` RATHER THAN `.optional()`. `.strict()` refuses unknown keys, not absent ones,
 * so an omitted field is already legal — but a defaulted one means the SERVICE's input type has no
 * `undefined` arm to handle, and the difference between "not sent" and "explicitly nothing" never
 * reaches the transaction as two states.
 */
const ReportIdSchema = z.uuid("A report id is a UUID.").nullable().default(null);

/**
 * The rights claim this decision answers, when there is one — `reportId`'s sibling, and never both.
 *
 * ⚠️ ACCEPTED ON EVERY ARM'S BODY, REFUSED BY THE SERVICE OFF THE TEARDOWN ARM. A claim only exists
 * on a teardown, so a case study or showcase decision naming one answers "claim not found" — the
 * same bytes as a claim about a different teardown. Splitting the command schema per arm to refuse
 * it earlier would fork a union three routes share.
 *
 * ⚠️ ONE CLAIM ANSWERS FOR ALL OF A TEARDOWN'S FILES. A claim may name a single document or part,
 * but no verb acts on a single file — a quarantine withholds them all — so the decision is taken on
 * the teardown and the claim records which file prompted it.
 */
const RightsClaimIdSchema = z.uuid("A rights claim id is a UUID.").nullable().default(null);

const BlueprintModerationVerbCommandSchema = z.discriminatedUnion("verb", [
  z
    .object({
      verb: z.literal("flag"),
      reasonNote: ReasonNoteSchema,
      reportId: ReportIdSchema,
      rightsClaimId: RightsClaimIdSchema,
    })
    .strict(),
  z
    .object({
      verb: z.literal("quarantine"),
      reasonNote: ReasonNoteSchema,
      reportId: ReportIdSchema,
      rightsClaimId: RightsClaimIdSchema,
    })
    .strict(),
  z
    .object({
      verb: z.literal("restore"),
      reasonNote: ReasonNoteSchema,
      reportId: ReportIdSchema,
      rightsClaimId: RightsClaimIdSchema,
    })
    .strict(),
]);

/**
 * ⚠️ A REPORT OR A CLAIM, NEVER BOTH. `blueprint_moderation_action_answered_ck` says the same in
 * SQL; refusing here names the field instead of surfacing a 23514.
 */
export const BlueprintModerationCommandSchema = BlueprintModerationVerbCommandSchema.superRefine(
  (command, context) => {
    if (command.reportId !== null && command.rightsClaimId !== null) {
      context.addIssue({
        code: "custom",
        path: ["rightsClaimId"],
        message: "A decision answers a report or a rights claim, not both.",
      });
    }
  },
);
