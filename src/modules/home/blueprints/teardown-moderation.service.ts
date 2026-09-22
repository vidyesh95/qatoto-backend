import { randomUUID } from "node:crypto";

import { and, asc, eq, gt, or, type SQL } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  teardown,
  teardownAssembly,
  teardownAssemblyStep,
  teardownDocument,
  teardownFastener,
  teardownManufacturingFile,
  teardownPart,
  teardownSubmissionFileUpload,
  teardownMaterial,
  teardownMaterialElement,
  teardownPartListing,
  teardownStats,
  teardownSubmission,
  user,
} from "#src/db/schema.js";
import { encodeInstantCursor, type InstantCursor } from "#src/lib/instant-cursor.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { buildErrorWithoutQueryParameters } from "#src/modules/home/blueprints/blueprint-write-errors.js";
import {
  noModelColumns,
  orderPartsParentsFirst,
  uploadedModelColumns,
} from "#src/modules/home/blueprints/teardown-assembly-write.js";
import {
  RESERVED_TEARDOWN_SLUGS,
  TEARDOWN_MANUFACTURING_METHODS,
} from "#src/modules/home/blueprints/teardown-import.schemas.js";
import {
  isTeardownDocumentKind,
  type SubmittedTeardownFile,
  TeardownSubmissionDocumentSchema,
  type TeardownModerationDecisionInput,
  type TeardownSubmissionDocument,
} from "#src/modules/home/blueprints/teardown-submission.schemas.js";
import { appendPlatformAuditEntry } from "#src/modules/platform/audit/platform-audit.service.js";
import type {
  PlatformAccessError,
  PlatformStaffContext,
} from "#src/modules/platform/roles/platform-role.service.js";
import { slugifyProgramTitle } from "#src/modules/rnd/programs/research-programs.service.js";
import type { Result } from "#src/types/index.js";

/**
 * The teardown review queue, and the decision on one submission.
 *
 * ⚠️ PUBLISHING IS WHERE A `teardown` ROW IS BORN. Everything before this point lives in
 * `teardown_submission`, which is deliberately not a teardown in waiting — see that table's header.
 * So this file is the only place the two shapes meet, and the meeting is a copy, not a migration:
 * the submission survives the publish and keeps pointing at what it produced.
 *
 * ⚠️ THE CAPABILITY CHECK IS THE CALLER'S JOB, and it has already happened. Every function takes a
 * `PlatformStaffContext` — the proof, not a user id — so neither can be called without standing
 * having been proven, and proven BEFORE any submission id is read: a 403 that only arrives for
 * submissions that exist turns this route into an existence oracle over unpublished work.
 *
 * ⚠️ THE AUDIT PAYLOAD IS IDS AND FLAGS ONLY. The chain is hash-linked and kept forever, and a
 * submission's document carries one party's account of a private permission with a named
 * manufacturer. The note the author reads lives on the submission row, where erasure can reach it;
 * the entry records only THAT a note was sent.
 */

type DatabaseExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type TeardownModerationError =
  | PlatformAccessError
  | { readonly type: "TEARDOWN_SUBMISSION_NOT_FOUND" }
  | { readonly type: "TEARDOWN_SELF_MODERATION_FORBIDDEN" }
  | {
      readonly type: "TEARDOWN_ALREADY_DECIDED";
      readonly moderationState: (typeof teardownSubmission.$inferSelect)["moderationState"];
    }
  | {
      readonly type: "TEARDOWN_SUBMISSION_UNPARSEABLE";
      readonly schemaVersion: number;
      readonly issues: readonly string[];
    };

/**
 * A stored document, parsed — or honestly refused.
 *
 * ⚠️ `unparseable` IS A REAL ARM, NOT DEFENSIVE CODING. A submission written in March is read by a
 * publish in June, against whatever this schema has become by then. When the two disagree the queue
 * must still render the row so a moderator can see it and send it back with a reason; a `throw`
 * would take down the whole page and hide every other submission on it.
 */
export type StoredTeardownDocument =
  | { readonly status: "present"; readonly document: TeardownSubmissionDocument }
  | {
      readonly status: "unparseable";
      readonly schemaVersion: number;
      readonly issues: readonly string[];
    };

export interface TeardownReviewQueueItem {
  readonly submissionId: string;
  readonly submittedAt: Date;
  readonly author: { readonly displayName: string; readonly handle: string | null };
  readonly title: string;
  readonly subjectProductName: string;
  readonly document: StoredTeardownDocument;
}

export interface TeardownReviewQueuePage {
  readonly items: readonly TeardownReviewQueueItem[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

export interface TeardownModerationDecisionView {
  readonly submissionId: string;
  readonly moderationState: "published" | "rejected";
  readonly publicSlug: string | null;
  readonly decidedAt: Date;
}

/**
 * Parses one stored document.
 *
 * The column is `text`, so reading it yields a string and never a domain type. `JSON.parse` returns
 * `unknown`, which goes to `safeParse` — there is no assertion anywhere on this path, which is the
 * point of storing text rather than jsonb.
 */
function readSubmissionDocument(
  rawDocumentJson: string,
  schemaVersion: number,
): StoredTeardownDocument {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawDocumentJson);
  } catch {
    return { status: "unparseable", schemaVersion, issues: ["The stored document is not JSON."] };
  }

  const parsedDocument = TeardownSubmissionDocumentSchema.safeParse(parsedJson);
  if (!parsedDocument.success) {
    return {
      status: "unparseable",
      schemaVersion,
      issues: parsedDocument.error.issues.map(
        (issue) => `${issue.path.join(".") || "document"}: ${issue.message}`,
      ),
    };
  }

  return { status: "present", document: parsedDocument.data };
}

/**
 * Submissions waiting for a decision, OLDEST FIRST.
 *
 * Oldest first for the reason every queue here is: newest-first starves its own tail, and the
 * submission that has waited longest is the one owed an answer.
 *
 * An inner join on `user` is a statement rather than a shortcut: every submission names an account,
 * so the non-null `displayName` this view promises is a property of the join.
 */
export async function listTeardownReviewQueue(input: {
  readonly staff: PlatformStaffContext;
  readonly limit: number;
  readonly cursor: InstantCursor | undefined;
}): Promise<TeardownReviewQueuePage> {
  const conditions: SQL[] = [eq(teardownSubmission.moderationState, "pending_review")];

  if (input.cursor !== undefined) {
    const { instant, id } = input.cursor;
    // Ascending, so `>`.
    const afterCursorCondition = or(
      gt(teardownSubmission.createdAt, instant),
      and(eq(teardownSubmission.createdAt, instant), gt(teardownSubmission.id, id)),
    );
    if (afterCursorCondition !== undefined) conditions.push(afterCursorCondition);
  }

  const rows = await db
    .select({
      submissionId: teardownSubmission.id,
      submittedAt: teardownSubmission.createdAt,
      title: teardownSubmission.title,
      subjectProductName: teardownSubmission.subjectProductName,
      documentJson: teardownSubmission.documentJson,
      documentSchemaVersion: teardownSubmission.documentSchemaVersion,
      authorDisplayName: user.name,
      authorHandle: user.handle,
    })
    .from(teardownSubmission)
    .innerJoin(user, eq(user.id, teardownSubmission.authorUserId))
    .where(and(...conditions))
    .orderBy(asc(teardownSubmission.createdAt), asc(teardownSubmission.id))
    .limit(input.limit + 1);

  const hasMore = rows.length > input.limit;
  const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
  const lastRow = pageRows.at(-1);

  return {
    items: pageRows.map((row) => ({
      submissionId: row.submissionId,
      submittedAt: row.submittedAt,
      author: { displayName: row.authorDisplayName, handle: row.authorHandle },
      title: row.title,
      subjectProductName: row.subjectProductName,
      document: readSubmissionDocument(row.documentJson, row.documentSchemaVersion),
    })),
    page: {
      nextCursor:
        hasMore && lastRow
          ? encodeInstantCursor({ instant: lastRow.submittedAt, id: lastRow.submissionId })
          : null,
      hasMore,
    },
  };
}

/**
 * The public address a published teardown gets, before any collision suffix.
 *
 * A title of pure punctuation slugifies to nothing, and one that slugifies to a route literal would
 * be shadowed by that route; both fall back to an address derived from the id, which is ugly and
 * always usable. `RESERVED_TEARDOWN_SLUGS` is the one spelling of that list —
 * `db:verify-teardown-constraints` asserts `teardown_slug_ck` still agrees with it.
 */
function buildTeardownSlugBase(
  desiredSlug: string | null,
  title: string,
  teardownId: string,
): string {
  const candidateBase = desiredSlug ?? slugifyProgramTitle(title);
  const isReservedSlug = RESERVED_TEARDOWN_SLUGS.some(
    (reservedSlug) => reservedSlug === candidateBase,
  );
  if (candidateBase.length < 3 || isReservedSlug) {
    return `teardown-${teardownId.replaceAll("-", "").slice(0, 8)}`;
  }
  return candidateBase;
}

/** The YouTube poster, REBUILT from the id rather than taken from what the client sent. */
function buildWalkthroughPosterUrl(youtubeVideoId: string): string {
  return `https://i.ytimg.com/vi/${youtubeVideoId}/hqdefault.jpg`;
}

/**
 * Writes the `teardown` row under the first free slug.
 *
 * EACH ATTEMPT IN ITS OWN SAVEPOINT. A failed statement aborts the whole transaction in Postgres,
 * so a bare try/catch around a colliding insert would leave every later statement — the stats row,
 * five child inserts, the submission update and the audit append — failing with `25P02`. Drizzle's
 * nested `transaction` is SAVEPOINT / ROLLBACK TO SAVEPOINT, which keeps the outer transaction
 * usable.
 */
async function insertTeardownUnderFreeSlug(
  transaction: DatabaseExecutor,
  teardownId: string,
  values: Omit<typeof teardown.$inferInsert, "slug">,
  desiredSlug: string | null,
): Promise<string> {
  const baseSlug = buildTeardownSlugBase(desiredSlug, values.title, teardownId);
  const candidateSlugs = [
    baseSlug,
    ...Array.from(
      { length: 10 },
      (_unused, suffixIndex) => `${baseSlug}-${String(suffixIndex + 2)}`,
    ),
    `${baseSlug}-${teardownId.replaceAll("-", "").slice(0, 8)}`,
  ];

  for (const candidateSlug of candidateSlugs) {
    try {
      await transaction.transaction(async (savepoint) => {
        await savepoint.insert(teardown).values({ ...values, slug: candidateSlug });
      });
      return candidateSlug;
    } catch (insertError: unknown) {
      if (!isUniqueViolation(insertError)) throw insertError;
      // Taken — try the next candidate.
    }
  }

  throw new Error(`insertTeardownUnderFreeSlug: every slug candidate for ${teardownId} was taken`);
}

/**
 * Copies one parsed submission into the ten public teardown tables.
 *
 * ⚠️ WHAT IS DELIBERATELY NOT WRITTEN: `teardown_assembly`, `teardown_part`,
 * `teardown_assembly_step` and `teardown_fastener`. The wizard collects no geometry, so
 * `teardown_part_arm_shape_ck` is never consulted — the author's parts go to
 * `teardown_part_listing`, which is a contents page rather than a viewer.
 *
 * ⚠️ `documents[]` IS ROUTED BY ITS OWN LABEL, not by the array it arrived in. The wizard once served
 * both file lists from one schema whose `kind` was the manufacturing-file enum; it has since been
 * split, and no submission carrying the mixed shape was ever stored. Routing by label is what made
 * that release a no-op here, and it now stands as the backstop for a caller on a cached bundle:
 * whatever array a file arrives in, it lands in the table that can hold what its author said it was.
 */
/**
 * The three storage columns one submitted file becomes, on whichever arm it arrived.
 *
 * ⚠️ A `switch` WITH A `never` DEFAULT, AND IT RETURNS ALL FIVE KEYS ON BOTH ARMS.
 * `teardown_document_source_ck` decides which combination is legal, and writing every column makes
 * the two that stay NULL visible at the call site rather than resting on which properties happened
 * to be omitted — the same reason `targetColumnsForArm` spells its nulls out.
 *
 * ⚠️ THE UPLOADED ARM COPIES THE MEASURED SIZE, WHICH IS THE FACT §3.3 SAID NOBODY HAD. Its
 * argument for a NULL `byte_size` was that the only ways to fill it were a HEAD inside this very
 * transaction or a moderator typing a number about a file they never opened. An upload measured the
 * bytes at intake, so the figure is neither of those.
 */
function storageColumnsForSubmittedFile(
  file: SubmittedTeardownFile,
  stagedUploadsById: ReadonlyMap<string, StagedUploadRow>,
): {
  source: "pasted_link" | "uploaded";
  url: string | null;
  objectStorageKey: string | null;
  contentSha256: string | null;
  byteSize: number | null;
} {
  switch (file.source) {
    case "pasted_link":
      return {
        source: "pasted_link",
        url: file.url,
        objectStorageKey: null,
        contentSha256: null,
        // Unmeasured: the wire carried a pasted link and no size.
        byteSize: null,
      };
    case "uploaded": {
      const staged = stagedUploadsById.get(file.uploadId);
      if (staged === undefined) {
        /*
         * Unreachable: `submitTeardown` proved every id belongs to this author and claimed it, and
         * this runs inside the publish transaction that loaded them. A throw is correct HERE — an
         * absent row means the claim and this read disagree about the same table, which is a
         * programmer error rather than an operational one, and rolling the publish back is the only
         * safe answer.
         */
        throw new Error(`Submission names upload ${file.uploadId}, which no longer exists.`);
      }
      return {
        source: "uploaded",
        url: null,
        objectStorageKey: staged.objectStorageKey,
        contentSha256: staged.contentSha256,
        byteSize: staged.byteSize,
      };
    }
    default: {
      const exhaustiveCheck: never = file;
      throw new Error(`Unhandled submitted file source: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * The staged row an id names, or a throw.
 *
 * A throw is correct here and a `Result` is not: `submitTeardown` already proved every id belongs
 * to this author and claimed it, and this runs inside the publish transaction that loaded them. An
 * absent row means the claim and this read disagree about the same table — a programmer error, and
 * rolling the publish back is the only safe answer.
 */
function requireStagedUpload(
  uploadId: string,
  stagedUploadsById: ReadonlyMap<string, StagedUploadRow>,
): StagedUploadRow {
  const staged = stagedUploadsById.get(uploadId);
  if (staged === undefined) {
    throw new Error(`Submission names upload ${uploadId}, which no longer exists.`);
  }
  return staged;
}

interface StagedUploadRow {
  readonly objectStorageKey: string;
  readonly contentSha256: string;
  readonly byteSize: number;
}

async function copySubmissionIntoTeardown(
  transaction: DatabaseExecutor,
  teardownId: string,
  document: TeardownSubmissionDocument,
  submissionId: string,
): Promise<void> {
  await transaction.insert(teardownStats).values({ teardownId });

  /*
   * The staged uploads this submission claimed, in ONE read rather than one per file. Keyed by
   * upload id because that is what the document names.
   */
  const stagedUploadRows = await transaction
    .select({
      id: teardownSubmissionFileUpload.id,
      objectStorageKey: teardownSubmissionFileUpload.objectStorageKey,
      contentSha256: teardownSubmissionFileUpload.contentSha256,
      byteSize: teardownSubmissionFileUpload.byteSize,
    })
    .from(teardownSubmissionFileUpload)
    .where(eq(teardownSubmissionFileUpload.submissionId, submissionId));
  const stagedUploadsById = new Map<string, StagedUploadRow>(
    stagedUploadRows.map((row) => [
      row.id,
      {
        objectStorageKey: row.objectStorageKey,
        contentSha256: row.contentSha256,
        byteSize: row.byteSize,
      },
    ]),
  );

  if (document.parts.length > 0) {
    await transaction.insert(teardownPartListing).values(
      document.parts.map((part, position) => ({
        teardownId,
        position,
        label: part.label,
        material: part.material,
      })),
    );
  }

  const submittedFiles = [...document.documents, ...document.manufacturingFiles];
  const readerFiles = submittedFiles.flatMap((file) =>
    isTeardownDocumentKind(file.kind) ? [{ ...file, kind: file.kind }] : [],
  );
  const fabricationFiles = submittedFiles.flatMap((file) =>
    isTeardownDocumentKind(file.kind) ? [] : [{ ...file, kind: file.kind }],
  );

  if (readerFiles.length > 0) {
    await transaction.insert(teardownDocument).values(
      readerFiles.map((file, position) => ({
        // Minted here: `teardown_document.id` is a GLOBAL primary key with no default.
        id: randomUUID(),
        teardownId,
        position,
        kind: file.kind,
        title: file.title,
        ...storageColumnsForSubmittedFile(file, stagedUploadsById),
        pageCount: null,
      })),
    );
  }

  if (fabricationFiles.length > 0) {
    await transaction.insert(teardownManufacturingFile).values(
      fabricationFiles.map((file, position) => ({
        id: randomUUID(),
        teardownId,
        position,
        kind: file.kind,
        title: file.title,
        ...storageColumnsForSubmittedFile(file, stagedUploadsById),
      })),
    );
  }

  /*
   * THE ASSEMBLY, ITS PARTS, ITS STEPS AND ITS FASTENERS — in the order the seed proved legal.
   *
   * ⚠️ THE FOUR TABLES NEEDED NO DDL TO ACCEPT AUTHORED ROWS, which is the strongest evidence the
   * authoring path belongs on the submit route rather than on a post-publish surface: they were
   * built for exactly this shape. §3.1's argument against relaxing `teardown` does not transfer —
   * none of these has a moderator-supplied column or a NOT NULL an author cannot answer.
   */
  if (document.assembly !== null) {
    const assemblyModel =
      document.assembly.kind === "composite"
        ? uploadedModelColumns(
            requireStagedUpload(document.assembly.model.modelUploadId, stagedUploadsById),
          )
        : noModelColumns();

    const [insertedAssembly] = await transaction
      .insert(teardownAssembly)
      .values({
        teardownId,
        kind: document.assembly.kind,
        explosionAxisX: document.assembly.explosionAxis?.[0] ?? null,
        explosionAxisY: document.assembly.explosionAxis?.[1] ?? null,
        explosionAxisZ: document.assembly.explosionAxis?.[2] ?? null,
        ...assemblyModel,
      })
      .returning({ id: teardownAssembly.id });
    if (!insertedAssembly) throw new Error("teardown assembly insert returned no row");

    /*
     * ⚠️ BRANCHED ON `kind` RATHER THAN PROBED WITH `"model" in part`, because the two arms are a
     * discriminated union and only the discriminant narrows them. The `in` test compiles and then
     * collapses both arms to their intersection, which loses `placement` and types `model` as
     * unknown — the union's whole point, defeated by the shorthand.
     */
    const sharedPartColumns = (
      part: {
        readonly id: string;
        readonly label: string;
        readonly parentPartId: string | null;
        readonly material: string;
        readonly manufacturingMethod: (typeof TEARDOWN_MANUFACTURING_METHODS)[number];
        readonly explosionDirection: readonly [number, number, number] | null;
        readonly explosionDistanceMm: number | null;
        readonly layerIndex: number | null;
        readonly stressRating: number | null;
        readonly calloutText: string | null;
      },
      position: number,
    ) => ({
      id: part.id,
      assemblyId: insertedAssembly.id,
      parentPartId: part.parentPartId,
      position,
      label: part.label,
      material: part.material,
      manufacturingMethod: part.manufacturingMethod,
      explosionDirectionX: part.explosionDirection?.[0] ?? null,
      explosionDirectionY: part.explosionDirection?.[1] ?? null,
      explosionDirectionZ: part.explosionDirection?.[2] ?? null,
      explosionDistanceMm: part.explosionDistanceMm,
      layerIndex: part.layerIndex,
      stressRating: part.stressRating,
      calloutText: part.calloutText,
    });

    if (document.assembly.kind === "composite") {
      for (const { part, position } of orderPartsParentsFirst(document.assembly.parts)) {
        await transaction.insert(teardownPart).values({
          ...sharedPartColumns(part, position),
          assemblyKind: "composite",
          nodeName: part.nodeName,
          ...noModelColumns(),
          placementPositionX: null,
          placementPositionY: null,
          placementPositionZ: null,
          placementRotationX: null,
          placementRotationY: null,
          placementRotationZ: null,
        });
      }
    } else {
      for (const { part, position } of orderPartsParentsFirst(document.assembly.parts)) {
        await transaction.insert(teardownPart).values({
          ...sharedPartColumns(part, position),
          assemblyKind: "individual_parts",
          nodeName: null,
          ...uploadedModelColumns(requireStagedUpload(part.model.modelUploadId, stagedUploadsById)),
          placementPositionX: part.placement?.positionMm[0] ?? null,
          placementPositionY: part.placement?.positionMm[1] ?? null,
          placementPositionZ: part.placement?.positionMm[2] ?? null,
          placementRotationX: part.placement?.rotationDegrees[0] ?? null,
          placementRotationY: part.placement?.rotationDegrees[1] ?? null,
          placementRotationZ: part.placement?.rotationDegrees[2] ?? null,
        });
      }
    }

    if (document.assemblySteps.length > 0) {
      await transaction.insert(teardownAssemblyStep).values(
        document.assemblySteps.map((step) => ({
          teardownId,
          stepNumber: step.stepNumber,
          title: step.title,
          description: step.description,
          // Both columns travel together — the CHECK says so, and the composite FK needs the pair.
          assemblyId: step.focusedPartId === null ? null : insertedAssembly.id,
          focusedPartId: step.focusedPartId,
        })),
      );
    }
  }

  if (document.fasteners.length > 0) {
    await transaction.insert(teardownFastener).values(
      document.fasteners.map((fastener, position) => ({
        teardownId,
        position,
        standardCode: fastener.standardCode,
        sizeLabel: fastener.sizeLabel,
        drive: fastener.drive,
        quantity: fastener.quantity,
        supplierLabel: fastener.supplier?.label ?? null,
        supplierUrl: fastener.supplier?.url ?? null,
      })),
    );
  }

  for (const [position, material] of document.materials.entries()) {
    const materialId = randomUUID();
    await transaction.insert(teardownMaterial).values({
      id: materialId,
      teardownId,
      position,
      appliesToLabel: material.appliesToLabel,
      designation: material.designation,
      designationSource: material.designationSource,
      materialClass: material.materialClass,
      process: material.process,
      finish: material.finish,
      /*
       * Both NULL, which `teardown_material_part_ck` reads as a pair. A submission has no assembly,
       * so there is no part for a material to attach to — and the write gate refuses a non-null
       * `partId` by name rather than letting the two-hop foreign key fail here.
       */
      assemblyId: null,
      partId: null,
    });

    if (material.elements.length > 0) {
      await transaction.insert(teardownMaterialElement).values(
        material.elements.map((element, elementPosition) => ({
          materialId,
          position: elementPosition,
          symbol: element.symbol,
          minimumPercent: element.weightPercentRange?.minimumPercent ?? null,
          maximumPercent: element.weightPercentRange?.maximumPercent ?? null,
          analysisMethod: element.analysisMethod,
          instrumentLabel: element.instrumentLabel,
          operatorNote: element.operatorNote,
        })),
      );
    }
  }
}

/**
 * Publishes a submission or sends it back.
 *
 * `FOR UPDATE`, then refusals in a fixed order: no such submission (404), the moderator wrote it
 * (403), it is already decided (409), its document no longer parses (422). The update ALSO guards on
 * `pending_review` in its WHERE, so the lock and the predicate agree on what "undecided" means.
 *
 * ⚠️ `created_at` ON THE PUBLISHED TEARDOWN IS THE DECISION TIME, NOT THE SUBMIT TIME.
 * `teardown_public_newest_idx` orders the index by `created_at DESC`, so a submission that waited
 * three weeks in the queue would otherwise be published already buried. The trade-off is that
 * "newest" means newest READABLE rather than newest written, which is the honest reading for a
 * surface where nothing is readable until somebody decides it is.
 *
 * ⚠️ `part_count` STAYS NULL. It is the author's own tally of the unit's parts, and the schema is
 * explicit that it is unrelated to how many parts a listing carries — "148 is not nine and must not
 * become nine". Filling it from `parts.length` would be the platform inventing the author's count.
 */
export async function decideTeardown(input: {
  readonly submissionId: string;
  readonly decision: TeardownModerationDecisionInput;
  readonly staff: PlatformStaffContext;
}): Promise<Result<TeardownModerationDecisionView, TeardownModerationError>> {
  // A published note that trims to nothing is no note. A rejection's note is already non-empty.
  const moderatorNote =
    input.decision.moderatorNote === null || input.decision.moderatorNote === ""
      ? null
      : input.decision.moderatorNote;

  try {
    const outcome = await db.transaction(async (transaction) => {
      const [existingSubmission] = await transaction
        .select({
          id: teardownSubmission.id,
          authorUserId: teardownSubmission.authorUserId,
          moderationState: teardownSubmission.moderationState,
          documentJson: teardownSubmission.documentJson,
          documentSchemaVersion: teardownSubmission.documentSchemaVersion,
        })
        .from(teardownSubmission)
        .where(eq(teardownSubmission.id, input.submissionId))
        .for("update");

      if (!existingSubmission) return { kind: "missing" } as const;
      if (existingSubmission.authorUserId === input.staff.staffUserId) {
        return { kind: "self_moderation" } as const;
      }
      if (existingSubmission.moderationState !== "pending_review") {
        return {
          kind: "already_decided",
          moderationState: existingSubmission.moderationState,
        } as const;
      }

      const decidedAt = new Date();

      if (input.decision.decision === "rejected") {
        await transaction
          .update(teardownSubmission)
          .set({
            moderationState: "rejected",
            reviewedByUserId: input.staff.staffUserId,
            reviewedAt: decidedAt,
            moderatorNote,
            updatedAt: decidedAt,
          })
          .where(
            and(
              eq(teardownSubmission.id, existingSubmission.id),
              eq(teardownSubmission.moderationState, "pending_review"),
            ),
          );

        await appendPlatformAuditEntry(transaction, {
          eventKind: "teardown_rejected",
          actorUserId: input.staff.staffUserId,
          actorRoleSnapshot: input.staff.platformRole,
          actionLabel: "Sent a teardown back to its author",
          targetLabel: `teardown submission ${existingSubmission.id}`,
          payload: {
            submissionId: existingSubmission.id,
            decision: "rejected",
            hasModeratorNote: moderatorNote !== null,
          },
          occurredAt: decidedAt,
        });

        return { kind: "rejected", decidedAt } as const;
      }

      const storedDocument = readSubmissionDocument(
        existingSubmission.documentJson,
        existingSubmission.documentSchemaVersion,
      );
      if (storedDocument.status === "unparseable") {
        return {
          kind: "unparseable",
          schemaVersion: storedDocument.schemaVersion,
          issues: storedDocument.issues,
        } as const;
      }

      const { document } = storedDocument;
      const [authorRow] = await transaction
        .select({ name: user.name, handle: user.handle, image: user.image })
        .from(user)
        .where(eq(user.id, existingSubmission.authorUserId))
        .limit(1);

      if (!authorRow) throw new Error("teardown submission names an account that is gone");

      const teardownId = randomUUID();
      const { provenance } = document;

      const publicSlug = await insertTeardownUnderFreeSlug(
        transaction,
        teardownId,
        {
          id: teardownId,
          title: document.title,
          summary: document.summary,
          thumbnailUrl: input.decision.thumbnailUrl,
          authorUserId: existingSubmission.authorUserId,
          // The byline is a SNAPSHOT taken now. Renaming the account will not rewrite it.
          authorDisplayName: authorRow.name,
          authorHandle: authorRow.handle,
          authorAvatarUrl: authorRow.image,
          difficulty: input.decision.difficulty,
          cadFormat: null,
          tags: [...document.tags],
          partCount: null,
          subjectKind: document.subjectKind,
          moderationState: "published",
          provenanceKind: provenance.kind,
          provenanceSubjectProductName: provenance.subjectProductName,
          provenanceUnitAcquisition: provenance.unitAcquisition,
          provenanceSurveyMethods: [...provenance.surveyMethods],
          provenanceSurveyedAt: new Date(provenance.surveyedAt),
          provenanceLicenceName: provenance.licence?.name ?? null,
          provenanceLicenceUrl: provenance.licence?.url ?? null,
          provenanceAuthorizationNote: provenance.authorizationNote,
          provenanceAttestationAcceptedAt: new Date(provenance.attestationAcceptedAt),
          provenanceNotes: provenance.notes,
          walkthroughVideoSource: document.walkthroughVideo === null ? null : "youtube",
          walkthroughYoutubeVideoId: document.walkthroughVideo?.youtubeVideoId ?? null,
          // ⚠️ REBUILT, never the value the client sent. See `buildWalkthroughPosterUrl`.
          walkthroughPosterUrl:
            document.walkthroughVideo === null
              ? null
              : buildWalkthroughPosterUrl(document.walkthroughVideo.youtubeVideoId),
          walkthroughDurationSeconds: document.walkthroughVideo?.durationSeconds ?? null,
          createdAt: decidedAt,
        },
        input.decision.desiredSlug,
      );

      await copySubmissionIntoTeardown(transaction, teardownId, document, input.submissionId);

      await transaction
        .update(teardownSubmission)
        .set({
          moderationState: "published",
          publishedTeardownId: teardownId,
          reviewedByUserId: input.staff.staffUserId,
          reviewedAt: decidedAt,
          moderatorNote,
          updatedAt: decidedAt,
        })
        .where(
          and(
            eq(teardownSubmission.id, existingSubmission.id),
            eq(teardownSubmission.moderationState, "pending_review"),
          ),
        );

      await appendPlatformAuditEntry(transaction, {
        eventKind: "teardown_published",
        actorUserId: input.staff.staffUserId,
        actorRoleSnapshot: input.staff.platformRole,
        actionLabel: "Published a teardown",
        targetLabel: `teardown ${teardownId}`,
        /*
         * ⚠️ IDS AND FLAGS ONLY — see the file header. Not the title, not the unit, not the note,
         * and above all not the provenance. This chain outlives every erasure.
         */
        payload: {
          submissionId: existingSubmission.id,
          teardownId,
          decision: "published",
          hasModeratorNote: moderatorNote !== null,
        },
        occurredAt: decidedAt,
      });

      return { kind: "published", publicSlug, decidedAt } as const;
    });

    switch (outcome.kind) {
      case "missing":
        return { success: false, error: { type: "TEARDOWN_SUBMISSION_NOT_FOUND" } };
      case "self_moderation":
        return { success: false, error: { type: "TEARDOWN_SELF_MODERATION_FORBIDDEN" } };
      case "already_decided":
        return {
          success: false,
          error: {
            type: "TEARDOWN_ALREADY_DECIDED",
            moderationState: outcome.moderationState,
          },
        };
      case "unparseable":
        return {
          success: false,
          error: {
            type: "TEARDOWN_SUBMISSION_UNPARSEABLE",
            schemaVersion: outcome.schemaVersion,
            issues: outcome.issues,
          },
        };
      case "rejected":
        return {
          success: true,
          value: {
            submissionId: input.submissionId,
            moderationState: "rejected",
            publicSlug: null,
            decidedAt: outcome.decidedAt,
          },
        };
      case "published":
        return {
          success: true,
          value: {
            submissionId: input.submissionId,
            moderationState: "published",
            publicSlug: outcome.publicSlug,
            decidedAt: outcome.decidedAt,
          },
        };
      default: {
        const exhaustiveCheck: never = outcome;
        throw new Error(`Unhandled teardown decision outcome: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  } catch (decisionError: unknown) {
    /*
     * ⚠️ STRIPPED FOR THE SAME REASON THE SUBMIT IS. This transaction binds the whole provenance
     * block — including one party's account of a private permission — and the account's real name
     * into the byline.
     */
    throw buildErrorWithoutQueryParameters(
      decisionError,
      "decideTeardown",
      "this transaction binds a publisher's provenance and an account holder's name",
    );
  }
}
