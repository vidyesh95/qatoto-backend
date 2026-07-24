import { createHash } from "node:crypto";

import { and, asc, eq, isNull } from "drizzle-orm";

import { config } from "#src/config/index.js";
import { db } from "#src/db/index.js";
import { physicalWorkReceipt, receiptForensicsCheck } from "#src/db/schema.js";
import { uploadPhysicalReceipt, type CloudinaryError } from "#src/lib/cloudinary.js";
import { validateAndNormalizeImage, type ImageValidationError } from "#src/lib/image.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import {
  computePerceptualHash,
  perceptualHashDistance,
  readReceiptExif,
} from "#src/lib/receipt-forensics.js";
import type { ProjectAccessError } from "#src/services/project-membership.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Physical-work receipts (R_AND_D_BACKEND_STRUCTURE.md §9, §9.10;
 * PROOF_OF_EFFORT_SPEC.md §4's hardware edge case).
 *
 * EVERY MEASUREMENT HERE IS THE SERVER'S. Size, dimensions, content hash, perceptual
 * hash, capture time — none of them appear in a request body, and a client that sends one
 * is rejected by `.strict()`. The body carries a `receiptKind` and an idempotency key, and
 * nothing else (§13).
 *
 * THE FOUR FORENSIC CHECKS, and why one of them is deliberately inert:
 *
 *   `exif_present`             — a phone photograph carries EXIF; a stock image usually
 *                                does not. Absence is not proof of anything, so it FLAGS.
 *   `capture_time_consistency` — the shutter time against the claimed day.
 *   `device_fingerprint`       — make + model + body serial, SALTED AND HASHED before it
 *                                touches a column. §9.10: a camera serial is
 *                                biometric-adjacent in some jurisdictions and identifies a
 *                                person across every photo they have ever taken.
 *   `reverse_image_search`     — records `not_applicable`, always, in this phase. It ships
 *                                a member's photograph to a third party and therefore
 *                                needs its own explicit per-project consent, never bundled
 *                                into an OAuth grant (§9.10). Recording it as
 *                                `not_applicable` rather than omitting the row is the
 *                                honest encoding: the check exists, it did not run, and
 *                                nothing was silently uploaded.
 *
 * NEAR-DUPLICATES FLAG, THEY DO NOT REJECT. Identical bytes are refused outright by
 * `physical_work_receipt_content_unq`; a re-crop of the same scene is caught by the
 * perceptual hash and raised for a human, because a second honest photograph of the same
 * workbench is a normal thing to upload.
 */

export type PhysicalReceiptError =
  | ProjectAccessError
  | ImageValidationError
  | CloudinaryError
  | { type: "DUPLICATE_RECEIPT"; contentSha256: string }
  | { type: "RECEIPT_FILE_MISSING" };

export type ReceiptKind = (typeof physicalWorkReceipt.$inferSelect)["receiptKind"];

export interface UploadReceiptInput {
  readonly receiptKind: ReceiptKind;
  readonly idempotencyKey: string;
}

export interface PhysicalReceiptView {
  readonly id: string;
  readonly receiptKind: ReceiptKind;
  readonly contentSha256: string;
  readonly perceptualHash: string;
  readonly storedImageUrl: string | null;
  readonly sizeBytes: number;
  readonly widthPixels: number | null;
  readonly heightPixels: number | null;
  readonly capturedAt: Date | null;
  readonly claimId: string | null;
  readonly createdAt: Date;
  readonly forensics: readonly {
    readonly checkKind: (typeof receiptForensicsCheck.$inferSelect)["checkKind"];
    readonly result: (typeof receiptForensicsCheck.$inferSelect)["result"];
    readonly findingSummary: string | null;
  }[];
}

/** Below this Hamming distance, two dHashes are almost certainly the same picture. */
const NEAR_DUPLICATE_DISTANCE = 10;

/** Receipts are stored at 2048px: legible for a human reviewer, cheap to serve. */
const RECEIPT_MAX_DIMENSION_PX = 2_048;

/**
 * The salt for the device fingerprint hash.
 *
 * Derived from `BETTER_AUTH_SECRET` rather than given its own env var, because a
 * deployment that forgot to set a dedicated one would silently fall back to an empty salt
 * — and an unsalted hash of a camera serial is a rainbow-table lookup away from being the
 * serial. This value already exists everywhere the app runs and is already a secret.
 */
function hashDeviceFingerprint(fingerprintSource: string): string {
  return createHash("sha256")
    .update(`${config.BETTER_AUTH_SECRET}:device:${fingerprintSource}`, "utf8")
    .digest("hex");
}

/**
 * `POST …/physical-receipts` — multipart in, measurements out. **202**, because the
 * receipt is evidence awaiting a claim rather than a claim itself.
 */
export async function uploadReceipt(
  context: { readonly projectId: string; readonly memberId: string },
  rawReceiptBytes: Buffer,
  input: UploadReceiptInput,
): Promise<Result<PhysicalReceiptView, PhysicalReceiptError>> {
  // A replayed key returns the original receipt rather than storing the bytes twice.
  const replayed = await findReceiptByIdempotencyKey(context.memberId, input.idempotencyKey);
  if (replayed) {
    return { success: true, value: replayed };
  }

  // Hashed from the RAW upload, before normalization: the re-encode strips EXIF and
  // changes every byte, so a hash of the stored copy would identify our output rather
  // than the member's evidence.
  const contentSha256 = createHash("sha256").update(rawReceiptBytes).digest("hex");

  const normalized = await validateAndNormalizeImage(rawReceiptBytes, {
    outputMaxDimensionPx: RECEIPT_MAX_DIMENSION_PX,
    outputFormat: "webp",
  });
  if (!normalized.success) {
    return { success: false, error: normalized.error };
  }

  const [perceptualHash, exif] = await Promise.all([
    computePerceptualHash(rawReceiptBytes),
    readReceiptExif(rawReceiptBytes),
  ]);

  const nearDuplicates = await findNearDuplicates(context.projectId, perceptualHash);

  const stored = await uploadPhysicalReceipt(
    context.projectId,
    contentSha256,
    normalized.value.buffer,
  );
  if (!stored.success) {
    return { success: false, error: stored.error };
  }

  try {
    const receiptId = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(physicalWorkReceipt)
        .values({
          projectId: context.projectId,
          memberId: context.memberId,
          receiptKind: input.receiptKind,
          contentSha256,
          perceptualHash,
          storedImageUrl: stored.value.secureUrl,
          storedImagePublicId: stored.value.publicId,
          // The RAW byte count, not the re-encoded one: what the member actually uploaded
          // is the fact worth recording.
          sizeBytes: rawReceiptBytes.byteLength,
          widthPixels: normalized.value.width,
          heightPixels: normalized.value.height,
          capturedAt: exif.capturedAt,
          deviceFingerprintHash:
            exif.deviceFingerprintSource === null
              ? null
              : hashDeviceFingerprint(exif.deviceFingerprintSource),
          idempotencyKey: input.idempotencyKey,
        })
        .returning({ id: physicalWorkReceipt.id });

      if (!inserted) {
        throw new Error("uploadReceipt: insert returned no row");
      }

      await tx.insert(receiptForensicsCheck).values([
        {
          receiptId: inserted.id,
          checkKind: "exif_present",
          result: exif.hasExif ? "pass" : "flag",
          findingSummary: exif.hasExif
            ? "The upload carries camera metadata."
            : "No camera metadata. Common for screenshots, exports and stock images — a human should look.",
        },
        {
          receiptId: inserted.id,
          checkKind: "capture_time_consistency",
          result: exif.capturedAt === null ? "not_applicable" : "pass",
          findingSummary:
            exif.capturedAt === null
              ? "No capture time to compare against the claimed day."
              : `Shutter fired at ${exif.capturedAt.toISOString()}.`,
        },
        {
          receiptId: inserted.id,
          checkKind: "device_fingerprint",
          result: exif.deviceFingerprintSource === null ? "not_applicable" : "pass",
          findingSummary:
            exif.deviceFingerprintSource === null
              ? "No device identity in the metadata."
              : "Device identity recorded as a salted hash; the raw serial is never stored.",
        },
        {
          receiptId: inserted.id,
          checkKind: "reverse_image_search",
          // NEVER silently run. It ships a member's photograph to a third party and needs
          // its own explicit consent, which does not exist yet (§9.10).
          result: "not_applicable",
          findingSummary:
            "Reverse image search requires separate, explicit consent and is not enabled. Nothing was uploaded to a third party.",
        },
      ]);

      if (nearDuplicates.length > 0) {
        await tx
          .update(receiptForensicsCheck)
          .set({
            result: "flag",
            findingSummary: `Visually near-identical to ${nearDuplicates.length} existing receipt(s) on this project. Identical bytes are refused outright; a re-crop is raised here for a human.`,
          })
          .where(
            and(
              eq(receiptForensicsCheck.receiptId, inserted.id),
              eq(receiptForensicsCheck.checkKind, "exif_present"),
            ),
          );
      }

      return inserted.id;
    });

    const view = await findReceipt(context.projectId, receiptId);
    if (!view) {
      throw new Error("uploadReceipt: receipt could not be read back");
    }
    return { success: true, value: view };
  } catch (error: unknown) {
    // `physical_work_receipt_content_unq`: THE SAME BYTES CANNOT FUND TWO RECEIPTS (§9.6).
    if (isUniqueViolation(error)) {
      return { success: false, error: { type: "DUPLICATE_RECEIPT", contentSha256 } };
    }
    throw error;
  }
}

/**
 * Receipts on this project whose perceptual hash is close enough to be the same picture.
 *
 * Compared in TypeScript rather than SQL because the distance is a bit count over a
 * 64-bit hash, and expressing that in SQL would either need an extension or a hand-rolled
 * bit-twiddling expression that has to agree exactly with the one here. A project's
 * receipt count is small; the honest simple version wins.
 */
async function findNearDuplicates(
  projectId: string,
  perceptualHash: string,
): Promise<readonly { readonly id: string; readonly distance: number }[]> {
  const existing = await db
    .select({ id: physicalWorkReceipt.id, perceptualHash: physicalWorkReceipt.perceptualHash })
    .from(physicalWorkReceipt)
    .where(eq(physicalWorkReceipt.projectId, projectId));

  return existing
    .map((receipt) => ({
      id: receipt.id,
      distance:
        receipt.perceptualHash.length === perceptualHash.length
          ? perceptualHashDistance(receipt.perceptualHash, perceptualHash)
          : Number.MAX_SAFE_INTEGER,
    }))
    .filter((candidate) => candidate.distance <= NEAR_DUPLICATE_DISTANCE);
}

async function findReceiptByIdempotencyKey(
  memberId: string,
  idempotencyKey: string,
): Promise<PhysicalReceiptView | null> {
  const [row] = await db
    .select({ id: physicalWorkReceipt.id, projectId: physicalWorkReceipt.projectId })
    .from(physicalWorkReceipt)
    .where(
      and(
        eq(physicalWorkReceipt.memberId, memberId),
        eq(physicalWorkReceipt.idempotencyKey, idempotencyKey),
      ),
    );

  return row ? findReceipt(row.projectId, row.id) : null;
}

/** One receipt with its forensic checks, scoped to its project. */
export async function findReceipt(
  projectId: string,
  receiptId: string,
): Promise<PhysicalReceiptView | null> {
  const [receipt] = await db
    .select()
    .from(physicalWorkReceipt)
    .where(
      and(eq(physicalWorkReceipt.id, receiptId), eq(physicalWorkReceipt.projectId, projectId)),
    );

  if (!receipt) return null;

  const forensics = await db
    .select({
      checkKind: receiptForensicsCheck.checkKind,
      result: receiptForensicsCheck.result,
      findingSummary: receiptForensicsCheck.findingSummary,
    })
    .from(receiptForensicsCheck)
    .where(eq(receiptForensicsCheck.receiptId, receiptId))
    .orderBy(asc(receiptForensicsCheck.checkKind));

  return {
    id: receipt.id,
    receiptKind: receipt.receiptKind,
    contentSha256: receipt.contentSha256,
    perceptualHash: receipt.perceptualHash,
    storedImageUrl: receipt.storedImageUrl,
    sizeBytes: receipt.sizeBytes,
    widthPixels: receipt.widthPixels,
    heightPixels: receipt.heightPixels,
    capturedAt: receipt.capturedAt,
    claimId: receipt.claimId,
    createdAt: receipt.createdAt,
    forensics,
  };
}

/**
 * `GET …/physical-receipts` — the member's OWN unclaimed receipts, ready to cite.
 *
 * Scoped to the caller rather than to the project: a receipt is evidence about one
 * person's work, and listing everyone's would let a member discover which photographs to
 * cite in a claim of their own.
 */
export async function listUnclaimedReceipts(
  projectId: string,
  memberId: string,
): Promise<readonly PhysicalReceiptView[]> {
  const rows = await db
    .select({ id: physicalWorkReceipt.id })
    .from(physicalWorkReceipt)
    .where(
      and(
        eq(physicalWorkReceipt.projectId, projectId),
        eq(physicalWorkReceipt.memberId, memberId),
        isNull(physicalWorkReceipt.claimId),
      ),
    )
    .orderBy(asc(physicalWorkReceipt.createdAt), asc(physicalWorkReceipt.id));

  const views = await Promise.all(rows.map((row) => findReceipt(projectId, row.id)));
  return views.filter((view): view is PhysicalReceiptView => view !== null);
}
