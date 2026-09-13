import { z } from "zod";

export const BLUEPRINT_MODERATION_REASON_NOTE_MAXIMUM_CHARACTERS = 2000;

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

export const BlueprintModerationCommandSchema = z.discriminatedUnion("verb", [
  z
    .object({ verb: z.literal("flag"), reasonNote: ReasonNoteSchema, reportId: ReportIdSchema })
    .strict(),
  z
    .object({
      verb: z.literal("quarantine"),
      reasonNote: ReasonNoteSchema,
      reportId: ReportIdSchema,
    })
    .strict(),
  z
    .object({ verb: z.literal("restore"), reasonNote: ReasonNoteSchema, reportId: ReportIdSchema })
    .strict(),
]);
export type BlueprintModerationCommand = z.infer<typeof BlueprintModerationCommandSchema>;
