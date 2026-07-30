import { createHash } from "node:crypto";

import { and, count, desc, eq, inArray, lt, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { researchPaperCategory, researchProgramPaper, user } from "#src/db/schema.js";
import { encodeInstantCursor, type InstantCursor } from "#src/lib/instant-cursor.js";
import {
  deleteResearchPaper,
  presignPaperDownload,
  uploadResearchPaper,
  type ObjectStorageError,
} from "#src/lib/object-storage.js";
import { isPdfValidationError, validatePdfBytes, type PdfValidationError } from "#src/lib/pdf.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import {
  PROGRAM_AUTHOR_COLUMNS,
  toProgramAuthorView,
  type ProgramAccessError,
  type ProgramAuthorView,
} from "#src/services/research-program-access.service.js";
import type { Result } from "#src/types/index.js";

/**
 * The §10 formal paper library (R_AND_D_BACKEND_STRUCTURE.md §10, §11f).
 *
 * A ROW EXISTS BEFORE ITS BYTES DO, and the two-step is deliberate:
 *
 *   POST …/papers            → 201, metadata row, `moderationStatus: "queued"`, no file
 *   POST …/papers/:id/file   → 200, the PDF attached
 *
 * Splitting them means a failed or retried upload does not re-mint a row and does not
 * re-run the DOI check, the multipart route stays small, and a paper with a DOI but no
 * local copy is a representable state — which it has to be, because object storage is
 * optional (§A2) and a program must still work without it.
 *
 * DEDUPLICATED TWICE, BY DOI AND BY CONTENT HASH (§10), and neither subsumes the other.
 * The same paper re-uploaded under a new title is caught by its bytes; the same paper
 * re-encoded to different bytes is caught by its DOI. Both are PARTIAL unique indexes, and
 * both are enforced by letting the write try and translating 23505 — never by
 * check-then-insert, which is a TOCTOU race two concurrent uploaders win together.
 *
 * VALIDATION IS NOT REVIEW. `validatePdfBytes` proves the bytes are a PDF. Whether the
 * paper is what its title says, whether it is plagiarised, and whether it belongs in this
 * program are moderation questions — which is why every paper lands `queued` and is
 * invisible to the public library until a `moderate_content` holder approves it.
 */

export type ResearchPaperModerationStatus =
  (typeof researchProgramPaper.$inferSelect)["moderationStatus"];

export type ResearchPaperError =
  | ProgramAccessError
  | { type: "PAPER_NOT_FOUND"; paperId: string }
  | { type: "PAPER_CATEGORY_NOT_FOUND"; categoryId: string }
  | { type: "PAPER_CATEGORY_NOT_APPROVED"; categoryId: string }
  | { type: "BRANCH_NOT_FOUND"; branchId: string }
  | { type: "DUPLICATE_DOI"; doi: string }
  | { type: "DUPLICATE_PAPER"; contentSha256: string }
  | { type: "NOT_THE_UPLOADER" }
  | { type: "PAPER_ALREADY_REVIEWED"; status: ResearchPaperModerationStatus }
  | { type: "PAPER_FILE_ALREADY_ATTACHED" }
  | { type: "PAPER_FILE_MISSING"; paperId: string }
  | { type: "INVALID_PDF"; reason: PdfValidationError["type"] }
  | ObjectStorageError;

/** One paper as read back. `isUploadedByViewer` is per-request, never a column (§10). */
export interface ResearchPaperView {
  readonly paperId: string;
  readonly title: string;
  readonly categoryId: string;
  readonly categorySlug: string;
  readonly categoryDisplayLabel: string;
  readonly branchId: string | null;
  readonly doi: string | null;
  /** The uploader's CLAIMED affiliation. Never verified — render as attribution. */
  readonly authorAffiliation: string | null;
  readonly abstractText: string | null;
  readonly uploader: ProgramAuthorView;
  readonly moderationStatus: ResearchPaperModerationStatus;
  readonly flagReasons: readonly string[];
  readonly reviewerNote: string | null;
  readonly reviewedAt: Date | null;
  /** Integers on the wire; "2.4 MB" is a client locale decision (§10). */
  readonly fileByteSize: number | null;
  readonly hasFile: boolean;
  readonly isUploadedByViewer: boolean;
  readonly createdAt: Date;
}

const PAPER_SELECT_COLUMNS = {
  paperId: researchProgramPaper.id,
  title: researchProgramPaper.title,
  categoryId: researchProgramPaper.categoryId,
  categorySlug: researchPaperCategory.slug,
  categoryDisplayLabel: researchPaperCategory.label,
  branchId: researchProgramPaper.branchId,
  doi: researchProgramPaper.doi,
  authorAffiliation: researchProgramPaper.authorAffiliation,
  abstractText: researchProgramPaper.abstractText,
  moderationStatus: researchProgramPaper.moderationStatus,
  flagReasons: researchProgramPaper.flagReasons,
  reviewerNote: researchProgramPaper.reviewerNote,
  reviewedAt: researchProgramPaper.reviewedAt,
  fileByteSize: researchProgramPaper.fileByteSize,
  contentSha256: researchProgramPaper.contentSha256,
  uploaderUserId: researchProgramPaper.uploaderUserId,
  createdAt: researchProgramPaper.createdAt,
  ...PROGRAM_AUTHOR_COLUMNS,
} as const;

/**
 * The selected row, spelled out.
 *
 * Declared explicitly rather than derived from `PAPER_SELECT_COLUMNS` with a mapped type,
 * because a mapped type of `unknown` forces a widening cast inside `toPaperView` that oxlint
 * correctly flags as unsafe. One interface plus one cast at the QUERY boundary — where the
 * values genuinely arrive untyped from the driver — is honest about where the assumption is.
 */
interface RawPaperRow {
  readonly paperId: string;
  readonly title: string;
  readonly categoryId: string;
  readonly categorySlug: string;
  readonly categoryDisplayLabel: string;
  readonly branchId: string | null;
  readonly doi: string | null;
  readonly authorAffiliation: string | null;
  readonly abstractText: string | null;
  readonly moderationStatus: ResearchPaperModerationStatus;
  readonly flagReasons: string[];
  readonly reviewerNote: string | null;
  readonly reviewedAt: Date | null;
  readonly fileByteSize: number | null;
  readonly contentSha256: string | null;
  readonly uploaderUserId: string | null;
  readonly createdAt: Date;
  readonly authorUserId: string | null;
  readonly authorName: string | null;
  readonly authorHandle: string | null;
  readonly authorAvatarImageUrl: string | null;
  readonly authorLocationLabel: string | null;
}

/**
 * Normalizes a DOI so two spellings of one identifier collide on the unique index.
 *
 * DOIs are case-insensitive by specification and are routinely pasted as a full URL, so
 * `https://doi.org/10.1234/ABC`, `doi:10.1234/abc` and `10.1234/abc` are ONE paper. Without
 * this the dedup index sees three, which is the entire failure it exists to prevent.
 */
export function normalizeDoi(rawDoi: string): string {
  return rawDoi
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:/i, "")
    .toLowerCase();
}

function toPaperView(row: RawPaperRow, viewerUserId: string | null): ResearchPaperView {
  return {
    paperId: row.paperId,
    title: row.title,
    categoryId: row.categoryId,
    categorySlug: row.categorySlug,
    categoryDisplayLabel: row.categoryDisplayLabel,
    branchId: row.branchId,
    doi: row.doi,
    authorAffiliation: row.authorAffiliation,
    abstractText: row.abstractText,
    uploader: toProgramAuthorView(row),
    moderationStatus: row.moderationStatus,
    flagReasons: row.flagReasons,
    reviewerNote: row.reviewerNote,
    reviewedAt: row.reviewedAt,
    fileByteSize: row.fileByteSize,
    hasFile: row.contentSha256 !== null,
    // A property of the VIEWER, computed per request — §10 names this explicitly.
    isUploadedByViewer:
      viewerUserId !== null && row.uploaderUserId !== null
        ? row.uploaderUserId === viewerUserId
        : false,
    createdAt: row.createdAt,
  };
}

export interface ListPapersFilter {
  readonly limit: number;
  readonly cursor?: InstantCursor | undefined;
  readonly categoryId?: string | undefined;
  readonly branchId?: string | undefined;
  readonly moderationStatus?: ResearchPaperModerationStatus | undefined;
}

/**
 * The library, keyset-paginated on `(createdAt, id)`.
 *
 * VISIBILITY IS APPLIED IN SQL, not after the fetch. A non-`approved` paper is visible only
 * to its uploader and to staff — so the predicate is "approved OR mine", built here, because
 * filtering a page-limited result afterwards returns short pages and eventually an empty
 * one that is not the end of the list. Staff skip the clause entirely.
 */
export async function listProgramPapers(input: {
  readonly programId: string;
  readonly viewerUserId: string | null;
  readonly isStaff: boolean;
  readonly filter: ListPapersFilter;
}): Promise<{ readonly rows: readonly ResearchPaperView[]; readonly nextCursor: string | null }> {
  const conditions = [eq(researchProgramPaper.programId, input.programId)];

  if (!input.isStaff) {
    const visibilityClause =
      input.viewerUserId === null
        ? eq(researchProgramPaper.moderationStatus, "approved")
        : or(
            eq(researchProgramPaper.moderationStatus, "approved"),
            eq(researchProgramPaper.uploaderUserId, input.viewerUserId),
          );
    if (visibilityClause) conditions.push(visibilityClause);
  }

  if (input.filter.categoryId !== undefined) {
    conditions.push(eq(researchProgramPaper.categoryId, input.filter.categoryId));
  }
  if (input.filter.branchId !== undefined) {
    conditions.push(eq(researchProgramPaper.branchId, input.filter.branchId));
  }
  if (input.filter.moderationStatus !== undefined) {
    conditions.push(eq(researchProgramPaper.moderationStatus, input.filter.moderationStatus));
  }
  if (input.filter.cursor !== undefined) {
    const { instant, id } = input.filter.cursor;
    // The two-column keyset predicate. `<` on the instant OR (`=` on the instant AND `<`
    // on the id) — the tiebreak half is what stops two rows sharing a millisecond from
    // being skipped, which is the whole reason the cursor ends in a unique column.
    conditions.push(
      or(
        lt(researchProgramPaper.createdAt, instant),
        and(eq(researchProgramPaper.createdAt, instant), lt(researchProgramPaper.id, id)),
      )!,
    );
  }

  const rows = (await db
    .select(PAPER_SELECT_COLUMNS)
    .from(researchProgramPaper)
    .innerJoin(researchPaperCategory, eq(researchPaperCategory.id, researchProgramPaper.categoryId))
    .leftJoin(user, eq(user.id, researchProgramPaper.uploaderUserId))
    .where(and(...conditions))
    .orderBy(desc(researchProgramPaper.createdAt), desc(researchProgramPaper.id))
    // One extra row, to learn whether another page exists WITHOUT a second COUNT query.
    .limit(input.filter.limit + 1)) as RawPaperRow[];

  const hasMore = rows.length > input.filter.limit;
  const pageRows = hasMore ? rows.slice(0, input.filter.limit) : rows;
  const lastRow = pageRows.at(-1);

  return {
    rows: pageRows.map((row) => toPaperView(row, input.viewerUserId)),
    nextCursor:
      hasMore && lastRow
        ? encodeInstantCursor({ instant: lastRow.createdAt, id: lastRow.paperId })
        : null,
  };
}

/** One paper, with the same visibility rule as the list. */
export async function findProgramPaper(input: {
  readonly programId: string;
  readonly paperId: string;
  readonly viewerUserId: string | null;
  readonly isStaff: boolean;
}): Promise<ResearchPaperView | null> {
  const [row] = (await db
    .select(PAPER_SELECT_COLUMNS)
    .from(researchProgramPaper)
    .innerJoin(researchPaperCategory, eq(researchPaperCategory.id, researchProgramPaper.categoryId))
    .leftJoin(user, eq(user.id, researchProgramPaper.uploaderUserId))
    .where(
      and(
        eq(researchProgramPaper.id, input.paperId),
        // BOTH columns: a paper id from another program must be indistinguishable from a
        // nonexistent one.
        eq(researchProgramPaper.programId, input.programId),
      ),
    )) as RawPaperRow[];

  if (!row) return null;

  const view = toPaperView(row, input.viewerUserId);
  if (view.moderationStatus !== "approved" && !view.isUploadedByViewer && !input.isStaff) {
    return null;
  }
  return view;
}

/**
 * Creates the metadata row. No file yet.
 *
 * The category must exist AND be `approved`: a paper filed under a category still awaiting
 * moderation would be invisible in every facet, which reads to its uploader as a lost
 * upload.
 */
export async function createProgramPaper(input: {
  readonly programId: string;
  readonly title: string;
  readonly categoryId: string;
  readonly branchId: string | null;
  readonly doi: string | null;
  readonly authorAffiliation: string | null;
  readonly abstractText: string | null;
  readonly uploaderUserId: string;
}): Promise<Result<{ readonly paperId: string }, ResearchPaperError>> {
  const [category] = await db
    .select({ id: researchPaperCategory.id, status: researchPaperCategory.status })
    .from(researchPaperCategory)
    .where(eq(researchPaperCategory.id, input.categoryId));

  if (!category) {
    return {
      success: false,
      error: { type: "PAPER_CATEGORY_NOT_FOUND", categoryId: input.categoryId },
    };
  }
  if (category.status !== "approved") {
    return {
      success: false,
      error: { type: "PAPER_CATEGORY_NOT_APPROVED", categoryId: input.categoryId },
    };
  }

  const normalizedDoi = input.doi === null ? null : normalizeDoi(input.doi);

  try {
    const [created] = await db
      .insert(researchProgramPaper)
      .values({
        programId: input.programId,
        title: input.title,
        categoryId: input.categoryId,
        branchId: input.branchId,
        doi: normalizedDoi,
        authorAffiliation: input.authorAffiliation,
        abstractText: input.abstractText,
        uploaderUserId: input.uploaderUserId,
        // Explicit: every paper starts unreviewed, and a reader of this call should not
        // have to open schema.ts to learn it.
        moderationStatus: "queued",
      })
      .returning({ id: researchProgramPaper.id });

    if (!created) throw new Error("createProgramPaper: insert returned no row");
    return { success: true, value: { paperId: created.id } };
  } catch (insertError: unknown) {
    if (isUniqueViolation(insertError) && normalizedDoi !== null) {
      // The only unique index a metadata insert can violate is the DOI one — the content
      // index is partial on a column this insert leaves NULL.
      return { success: false, error: { type: "DUPLICATE_DOI", doi: normalizedDoi } };
    }
    throw insertError;
  }
}

/**
 * Attaches the PDF.
 *
 * ORDER IS LOAD-BEARING, and it is the same order `physical-receipts.service.ts` uses:
 * validate → hash → UPLOAD → then write the row. Storing the bytes before the row means a
 * failed insert leaves an orphan object, which is recoverable (the key is content-addressed,
 * so a retry overwrites it). Writing the row first and then failing the upload would leave a
 * row claiming a file that does not exist — a broken download link in the library, which is
 * not recoverable without a sweep.
 *
 * The dedup check on `contentSha256` is the DATABASE's, not a pre-read: two people
 * uploading the same PDF simultaneously both pass a pre-read and one takes the 23505.
 */
export async function attachPaperFile(input: {
  readonly programId: string;
  readonly paperId: string;
  readonly uploaderUserId: string;
  readonly pdfBytes: Buffer;
}): Promise<Result<{ readonly fileByteSize: number }, ResearchPaperError>> {
  const [existing] = await db
    .select({
      id: researchProgramPaper.id,
      title: researchProgramPaper.title,
      uploaderUserId: researchProgramPaper.uploaderUserId,
      contentSha256: researchProgramPaper.contentSha256,
    })
    .from(researchProgramPaper)
    .where(
      and(
        eq(researchProgramPaper.id, input.paperId),
        eq(researchProgramPaper.programId, input.programId),
      ),
    );

  if (!existing) {
    return { success: false, error: { type: "PAPER_NOT_FOUND", paperId: input.paperId } };
  }
  if (existing.uploaderUserId !== input.uploaderUserId) {
    // 403, not 404: they can already see the paper, so there is nothing left to protect.
    return { success: false, error: { type: "NOT_THE_UPLOADER" } };
  }
  if (existing.contentSha256 !== null) {
    // Replacing a file would silently change what a reviewer approved. Delete and
    // re-create instead, which re-queues it for review.
    return { success: false, error: { type: "PAPER_FILE_ALREADY_ATTACHED" } };
  }

  const validation = validatePdfBytes(input.pdfBytes);
  if (isPdfValidationError(validation)) {
    return { success: false, error: { type: "INVALID_PDF", reason: validation.type } };
  }

  const contentSha256 = createHash("sha256").update(input.pdfBytes).digest("hex");

  const uploadResult = await uploadResearchPaper({
    programId: input.programId,
    contentSha256,
    pdfBytes: input.pdfBytes,
    downloadFileName: existing.title,
  });
  if (!uploadResult.success) return { success: false, error: uploadResult.error };

  try {
    await db
      .update(researchProgramPaper)
      .set({
        contentSha256,
        fileByteSize: validation.byteSize,
        objectStorageKey: uploadResult.value.objectKey,
        storageProvider: "s3_compatible",
      })
      .where(eq(researchProgramPaper.id, input.paperId));
  } catch (updateError: unknown) {
    if (isUniqueViolation(updateError)) {
      // These exact bytes are already in this program under another row. The object we
      // just wrote is the SAME key the existing row points at (content-addressed), so it
      // must NOT be deleted — that would break the paper that legitimately owns it.
      return { success: false, error: { type: "DUPLICATE_PAPER", contentSha256 } };
    }
    throw updateError;
  }

  return { success: true, value: { fileByteSize: validation.byteSize } };
}

/**
 * Mints a download link.
 *
 * Authorization has already happened — the caller proved the paper is visible to them.
 * This only turns that decision into a short-lived URL, and the bytes travel from B2 to
 * the reader without passing through this process.
 */
export async function createPaperDownloadUrl(input: {
  readonly programId: string;
  readonly paperId: string;
}): Promise<
  Result<{ readonly downloadUrl: string; readonly expiresInSeconds: number }, ResearchPaperError>
> {
  const [row] = await db
    .select({ objectStorageKey: researchProgramPaper.objectStorageKey })
    .from(researchProgramPaper)
    .where(
      and(
        eq(researchProgramPaper.id, input.paperId),
        eq(researchProgramPaper.programId, input.programId),
      ),
    );

  if (!row) {
    return { success: false, error: { type: "PAPER_NOT_FOUND", paperId: input.paperId } };
  }
  if (row.objectStorageKey === null) {
    // A real state: a paper may carry a DOI and no local copy. Distinct from "no such
    // paper" so the UI can offer the DOI link instead of an error.
    return { success: false, error: { type: "PAPER_FILE_MISSING", paperId: input.paperId } };
  }

  const presigned = await presignPaperDownload(row.objectStorageKey);
  if (!presigned.success) return { success: false, error: presigned.error };
  return { success: true, value: presigned.value };
}

/**
 * Deletes a paper. The uploader may do so only while it is still `queued`; staff any time.
 *
 * Once APPROVED it is part of a public library other work may cite, and withdrawing it is a
 * moderation decision rather than an author's prerogative. The bytes go too — an
 * unreferenced object is storage nobody is paying for on purpose.
 */
export async function deleteProgramPaper(input: {
  readonly programId: string;
  readonly paperId: string;
  readonly actorUserId: string;
  readonly isStaff: boolean;
}): Promise<Result<{ readonly deleted: true }, ResearchPaperError>> {
  const [existing] = await db
    .select({
      id: researchProgramPaper.id,
      uploaderUserId: researchProgramPaper.uploaderUserId,
      moderationStatus: researchProgramPaper.moderationStatus,
      objectStorageKey: researchProgramPaper.objectStorageKey,
    })
    .from(researchProgramPaper)
    .where(
      and(
        eq(researchProgramPaper.id, input.paperId),
        eq(researchProgramPaper.programId, input.programId),
      ),
    );

  if (!existing) {
    return { success: false, error: { type: "PAPER_NOT_FOUND", paperId: input.paperId } };
  }

  if (!input.isStaff) {
    if (existing.uploaderUserId !== input.actorUserId) {
      return { success: false, error: { type: "NOT_THE_UPLOADER" } };
    }
    if (existing.moderationStatus !== "queued") {
      return {
        success: false,
        error: { type: "PAPER_ALREADY_REVIEWED", status: existing.moderationStatus },
      };
    }
  }

  // The ROW goes first. If the object delete then fails, the library is already correct and
  // what is left behind is an unreferenced object a sweep can find — whereas deleting the
  // object first and failing the row leaves a listed paper whose download 404s.
  await db.delete(researchProgramPaper).where(eq(researchProgramPaper.id, input.paperId));

  if (existing.objectStorageKey !== null) {
    const removal = await deleteResearchPaper(existing.objectStorageKey);
    // Deliberately NOT surfaced as a failure: the caller asked for the paper to be gone
    // from the library, and it is. A stranded object is an operational cleanup task, not
    // something the person deleting their own draft can act on.
    if (!removal.success) {
      console.warn(
        `deleteProgramPaper: row ${input.paperId} deleted but object ${existing.objectStorageKey} was not (${removal.error.type})`,
      );
    }
  }

  return { success: true, value: { deleted: true } };
}

/** Counts a program's papers by status, for the stats job and the moderation badge. */
export async function countProgramPapersByStatus(
  programId: string,
  statuses: readonly ResearchPaperModerationStatus[],
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(researchProgramPaper)
    .where(
      and(
        eq(researchProgramPaper.programId, programId),
        inArray(researchProgramPaper.moderationStatus, [...statuses]),
      ),
    );

  return row?.total ?? 0;
}

/**
 * How many APPROVED papers sit on each branch of a program, for `recompute-branch-signals`.
 *
 * One grouped query rather than one per branch: the job runs over every branch of every
 * published program, and an N+1 there is N+1 across the whole platform.
 */
export async function countApprovedPapersByBranch(
  programId: string,
): Promise<ReadonlyMap<string, number>> {
  const rows = await db
    .select({
      branchId: researchProgramPaper.branchId,
      paperCount: sql<number>`COUNT(*)::int`,
    })
    .from(researchProgramPaper)
    .where(
      and(
        eq(researchProgramPaper.programId, programId),
        eq(researchProgramPaper.moderationStatus, "approved"),
        sql`${researchProgramPaper.branchId} IS NOT NULL`,
      ),
    )
    .groupBy(researchProgramPaper.branchId);

  return new Map(
    rows.flatMap((row) => (row.branchId === null ? [] : [[row.branchId, row.paperCount] as const])),
  );
}
