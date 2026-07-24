import { and, asc, eq, isNull } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { workshopFile } from "#src/db/schema.js";
import { parseExternalLink, type ExternalLinkError } from "#src/lib/external-link.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import type { ProjectAccessError } from "#src/services/project-membership.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Workshop files — TODAY, LINKS (R_AND_D_BACKEND_STRUCTURE.md §8, "Files: an external
 * link, measured by nobody").
 *
 * WHAT THIS SERVICE DELIBERATELY DOES NOT DO. It does not mint a presigned upload URL, it
 * does not `HEAD` anything, and it never writes `sizeBytes` or `contentSha256`. There are
 * no bytes: the row records a URL, its allowlisted host, and who added it. The original
 * rule — "the server measures the bytes, the client's claim is never trusted" — survives
 * as a NULL rather than as a number nobody verified.
 *
 * The `hosted` variant of `workshop_file.source`, plus the nullable `storageProvider` and
 * `objectKey`, are the seam that makes restoring S3 (Appendix A) an insert. Nothing here
 * writes them, and nothing here may start to.
 */

export type WorkshopFileError =
  | ProjectAccessError
  | ExternalLinkError
  | { type: "FILE_NOT_FOUND"; fileId: string }
  | { type: "FILE_LINK_ALREADY_ADDED" };

export type WorkshopFileKind = (typeof workshopFile.$inferSelect)["fileKind"];

export interface WorkshopFileView {
  readonly id: string;
  readonly fileName: string;
  readonly fileKind: WorkshopFileKind;
  readonly source: (typeof workshopFile.$inferSelect)["source"];
  readonly externalUrl: string | null;
  /** Derived server-side, so a client can badge "Google Drive" without re-parsing. */
  readonly externalHost: string | null;
  /**
   * ALWAYS NULL for a linked file, and clients must render nothing rather than "0 B" or
   * "unknown size" (§8). It exists for the deferred hosted path.
   */
  readonly sizeBytes: number | null;
  readonly uploadedByMemberId: string;
  readonly createdAt: Date;
}

export interface AddFileLinkInput {
  readonly fileName: string;
  readonly fileKind: WorkshopFileKind;
  readonly externalUrl: string;
}

function toFileView(row: typeof workshopFile.$inferSelect): WorkshopFileView {
  return {
    id: row.id,
    fileName: row.fileName,
    fileKind: row.fileKind,
    source: row.source,
    externalUrl: row.externalUrl,
    externalHost: row.externalHost,
    sizeBytes: row.sizeBytes,
    uploadedByMemberId: row.uploadedByMemberId,
    createdAt: row.createdAt,
  };
}

/** The project's live files, oldest first. Removed rows are excluded, never deleted. */
export async function listFiles(projectId: string): Promise<readonly WorkshopFileView[]> {
  const rows = await db
    .select()
    .from(workshopFile)
    .where(and(eq(workshopFile.projectId, projectId), isNull(workshopFile.removedAt)))
    // §4c rule 4 — ends in a unique column so two files added in the same millisecond
    // never swap places between reads.
    .orderBy(asc(workshopFile.createdAt), asc(workshopFile.id));

  return rows.map(toFileView);
}

/**
 * Adds a link. The URL is parsed, host-allowlisted and NORMALIZED before it is stored —
 * the client's raw string never reaches a column and never reaches another member's
 * browser.
 */
export async function addFileLink(
  projectId: string,
  uploaderMemberId: string,
  input: AddFileLinkInput,
): Promise<Result<WorkshopFileView, WorkshopFileError>> {
  const parsedLink = parseExternalLink(input.externalUrl);
  if (!parsedLink.success) {
    return { success: false, error: parsedLink.error };
  }

  try {
    const [inserted] = await db
      .insert(workshopFile)
      .values({
        projectId,
        fileName: input.fileName,
        fileKind: input.fileKind,
        source: "external_link",
        externalUrl: parsedLink.value.normalizedUrl,
        externalHost: parsedLink.value.host,
        uploadedByMemberId: uploaderMemberId,
      })
      .returning();

    if (!inserted) {
      throw new Error("addFileLink: insert returned no row");
    }
    return { success: true, value: toFileView(inserted) };
  } catch (error: unknown) {
    // The partial unique index on (project_id, external_url) WHERE removed_at IS NULL.
    // Adding the same link twice is a mistake, not an intent — and because the index is
    // partial, a previously removed link can be re-added.
    if (isUniqueViolation(error)) {
      return { success: false, error: { type: "FILE_LINK_ALREADY_ADDED" } };
    }
    throw error;
  }
}

/**
 * Soft-removes a link.
 *
 * Never a hard delete: a workshop file may be referenced by a §9 claim, and the partial
 * unique index needs to tell "removed" from "never existed" so the same link can be added
 * again later.
 */
export async function removeFileLink(
  projectId: string,
  fileId: string,
  actorUserId: string,
): Promise<Result<{ readonly fileId: string }, WorkshopFileError>> {
  const [removed] = await db
    .update(workshopFile)
    .set({ removedAt: new Date(), removedByUserId: actorUserId })
    .where(
      and(
        eq(workshopFile.id, fileId),
        eq(workshopFile.projectId, projectId),
        // Re-removing an already-removed file is a 404, not a second write: the row the
        // caller is acting on is not in the list they were looking at.
        isNull(workshopFile.removedAt),
      ),
    )
    .returning({ id: workshopFile.id });

  if (!removed) {
    return { success: false, error: { type: "FILE_NOT_FOUND", fileId } };
  }
  return { success: true, value: { fileId } };
}
