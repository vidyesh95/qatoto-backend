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
 * The body of `POST /blueprints/admin/{teardowns,case-studies}/:id/moderation-state`.
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
 * ⚠️ THERE IS NO `reportId` FIELD YET, DELIBERATELY. The primary quarantine path is an EMAILED
 * rights claim — blueprints doc §3.7: "nothing posts to Qatoto, by that flow's own explicit
 * decision" — so a required report id would make the commonest case unexpressible. When a reader
 * report intake lands it adds a nullable one here rather than changing this contract.
 */
export const BlueprintModerationCommandSchema = z.discriminatedUnion("verb", [
  z.object({ verb: z.literal("flag"), reasonNote: ReasonNoteSchema }).strict(),
  z.object({ verb: z.literal("quarantine"), reasonNote: ReasonNoteSchema }).strict(),
  z.object({ verb: z.literal("restore"), reasonNote: ReasonNoteSchema }).strict(),
]);
export type BlueprintModerationCommand = z.infer<typeof BlueprintModerationCommandSchema>;
