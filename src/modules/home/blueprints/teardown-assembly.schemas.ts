import { z } from "zod";

import {
  AssemblyStepSchema,
  FastenerSchema,
  NonZeroVectorSchema,
  PartBaseShape,
  ThreeComponentVectorSchema,
} from "#src/modules/home/blueprints/teardown-import.schemas.js";

/**
 * The geometry an AUTHOR sends, as against the geometry the seed imports.
 *
 * ⚠️ ONE FIELD DIFFERS, AND EVERY OTHER SHAPE IS REUSED RATHER THAN RESTATED. The import schema's
 * `model: { url, byteSize }` becomes `modelUploadId` here, because an author has neither: the URL
 * of an uploaded `.glb` does not exist until a moderator publishes the submission, and the byte
 * size is a fact the server measured at intake. Sending either would be a client asserting
 * something it cannot know — the same reason `SubmittedMaterialSchema` omits `id`.
 *
 * `AssemblyStepSchema` and `FastenerSchema` are imported WHOLE. A step is a title, a number and a
 * focused part; a fastener is a designation and a count. Neither carries a file, so neither has an
 * authoring variant, and writing one would have been two schemas to keep in step for no gain.
 *
 * ⚠️ THE CROSS-ROW RULES ARE NOT HERE EITHER. `refineTeardownCrossSectionRules` holds all six —
 * acyclicity, parent-in-this-assembly, the layer/axis pairing, dense step numbering, unique part
 * ids, and a material's part — and `teardown-submission.schemas.ts` applies it to the whole
 * document. They span sibling rows, so no per-object schema can express them and no CHECK can see
 * them.
 */

/**
 * ⚠️ DERIVED AGAINST THE BODY BUDGET, NOT CHOSEN. Two ceilings bind the submission document:
 * `longFormBody` at 128 KB and `teardown_submission_document_ck` at 262,144 characters. A worst-case
 * part is roughly a kilobyte as `estimateBodyBytes` counts it — ids, a label, a material, a node
 * name, callout text and nine numbers — and the rest of the document already spends tens of
 * kilobytes. `teardown-submission.schemas.test.ts` asserts the whole schema still fits, so raising
 * this number fails the build rather than producing a 413 an author cannot act on.
 *
 * Do NOT raise `MAX_JSON_BODY_BYTES` to make room: it is the ceiling every route behind it inherits.
 */
export const MAX_SUBMITTED_ASSEMBLY_PARTS = 48;

/** A dense sequence from 1. `teardown_assembly_step_number_ck` bounds the stored value at 64. */
export const MAX_SUBMITTED_ASSEMBLY_STEPS = 48;

/** A fastener line is small; the ceiling exists so one submission cannot carry a catalogue. */
export const MAX_SUBMITTED_FASTENERS = 48;

/**
 * What an author sends in place of a model file.
 *
 * ⚠️ THE UPLOAD ID, AND NOTHING ELSE. The submit transaction resolves it against
 * `teardown_submission_file_upload`, proving in one statement that the upload is this author's and
 * still unclaimed; the publish then copies the object key and the measured size onto the row.
 */
export const SubmittedModelReferenceSchema = z
  .object({ modelUploadId: z.uuid("An upload id is a UUID.") })
  .strict();

const SubmittedCompositePartSchema = z
  .object({ ...PartBaseShape, nodeName: z.string().min(1).max(120) })
  .strict();

const SubmittedIndividualPartSchema = z
  .object({
    ...PartBaseShape,
    model: SubmittedModelReferenceSchema,
    placement: z
      .object({
        positionMm: ThreeComponentVectorSchema,
        rotationDegrees: ThreeComponentVectorSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();

/**
 * ⚠️ `.min(1)` ON BOTH ARMS, matching the import schema: a zero-part assembly on the wire is a
 * broken detail page rather than a degraded one. An author with no parts sends `assembly: null`.
 */
export const SubmittedAssemblySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("composite"),
      explosionAxis: NonZeroVectorSchema.nullable(),
      model: SubmittedModelReferenceSchema,
      parts: z.array(SubmittedCompositePartSchema).min(1).max(MAX_SUBMITTED_ASSEMBLY_PARTS),
    })
    .strict(),
  z
    .object({
      kind: z.literal("individual_parts"),
      explosionAxis: NonZeroVectorSchema.nullable(),
      parts: z.array(SubmittedIndividualPartSchema).min(1).max(MAX_SUBMITTED_ASSEMBLY_PARTS),
    })
    .strict(),
]);

export const SubmittedAssemblyStepSchema = AssemblyStepSchema;
export const SubmittedFastenerSchema = FastenerSchema;

export type SubmittedTeardownAssembly = z.infer<typeof SubmittedAssemblySchema>;
