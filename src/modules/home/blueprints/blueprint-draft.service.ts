import { and, count, desc, eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { blueprintDraft } from "#src/db/schema.js";
import type { Result } from "#src/types/index.js";

/**
 * Server-side drafts for the three authoring wizards.
 *
 * ⚠️ EVERY FUNCTION HERE IS OWNER-SCOPED, AND THERE IS NO STAFF ROUTE — not "not yet", but never.
 * Blueprints doc §6: "exactly one route in the whole router serves the real name" of a withheld
 * company, and that is the case-study review queue. A draft can hold that name, so a
 * moderator-visible draft would make it two — and §10.4 already refuses a widening of exactly that
 * shape. A draft is the author's own unfinished work and nobody else's business.
 *
 * ⚠️ THE DOCUMENT IS NEVER PARSED HERE. It is stored, returned to the person who wrote it, and
 * deleted. See `blueprint-draft.schemas.ts` for why that is the design rather than a shortcut.
 */

/**
 * Per-author ceilings.
 *
 * ⚠️ IN THE SERVICE, NOT IN A CHECK, because a CHECK cannot count sibling rows — the same reason
 * `teardown-import.schemas.ts` carries five rules SQL cannot express. The numbers are a product
 * decision and deliberately generous: a wizard that autosaves is expected to hold one draft per
 * thing a person is working on, not one per session.
 */
const MAX_BLUEPRINT_DRAFTS_PER_AUTHOR = 25;

export type BlueprintDraftError =
  /** ⚠️ ONE ANSWER for "no such draft" and "somebody else's draft" — see the error mapper. */
  | { readonly type: "BLUEPRINT_DRAFT_NOT_FOUND" }
  | { readonly type: "BLUEPRINT_DRAFT_LIMIT_REACHED"; readonly limit: number }
  | { readonly type: "BLUEPRINT_DRAFT_REVISION_STALE"; readonly currentRevision: number }
  | { readonly type: "BLUEPRINT_DRAFT_DOCUMENT_NOT_OBJECT" };

export type BlueprintDraftArm = "teardown" | "showcase_launch" | "case_study";

/** The list row. ⚠️ NO DOCUMENT: a wizard index must not ship three 256 KiB blobs to draw a list. */
export interface BlueprintDraftSummary {
  readonly draftId: string;
  readonly arm: BlueprintDraftArm;
  readonly label: string | null;
  readonly revision: number;
  readonly updatedAt: Date;
}

export interface BlueprintDraftView extends BlueprintDraftSummary {
  readonly document: string;
  readonly documentSchemaVersion: number;
}

/** The write receipt. Three scalars, matching every other receipt on this surface. */
export interface BlueprintDraftReceipt {
  readonly draftId: string;
  readonly revision: number;
  readonly updatedAt: Date;
}

/**
 * Proves the stored text is a JSON OBJECT before it reaches the column.
 *
 * ⚠️ A GUARDED PARSE, NOT A TRUST. `blueprint_draft_document_ck` requires `left(document_json, 1) =
 * '{'`, which catches an array or a scalar — but `{` alone does not prove the text parses, and a
 * document that does not parse is one the wizard cannot resume. Refusing here turns that into a 422
 * the author sees now rather than a broken resume next week.
 */
function isJsonObject(candidate: string): boolean {
  try {
    const parsed: unknown = JSON.parse(candidate);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

export async function createBlueprintDraft(input: {
  readonly ownerUserId: string;
  readonly arm: BlueprintDraftArm;
  readonly label: string | null;
  readonly document: string;
  readonly documentSchemaVersion: number;
}): Promise<Result<BlueprintDraftReceipt, BlueprintDraftError>> {
  if (!isJsonObject(input.document)) {
    return { success: false, error: { type: "BLUEPRINT_DRAFT_DOCUMENT_NOT_OBJECT" } };
  }

  /*
   * A READ, NOT A LOCK — the `uploadShowcaseWriteUpImage` rule. Two autosaves racing on an author's
   * last slot can both see the same count and both insert; the overshoot is one row, bounded by the
   * limiter, and the sweeper takes it eventually. A lock here would serialise every autosave.
   */
  const [countRow] = await db
    .select({ draftCount: count() })
    .from(blueprintDraft)
    .where(eq(blueprintDraft.ownerUserId, input.ownerUserId));
  if ((countRow?.draftCount ?? 0) >= MAX_BLUEPRINT_DRAFTS_PER_AUTHOR) {
    return {
      success: false,
      error: { type: "BLUEPRINT_DRAFT_LIMIT_REACHED", limit: MAX_BLUEPRINT_DRAFTS_PER_AUTHOR },
    };
  }

  const [inserted] = await db
    .insert(blueprintDraft)
    .values({
      ownerUserId: input.ownerUserId,
      arm: input.arm,
      label: input.label,
      documentJson: input.document,
      documentSchemaVersion: input.documentSchemaVersion,
    })
    .returning({
      id: blueprintDraft.id,
      revision: blueprintDraft.revision,
      updatedAt: blueprintDraft.updatedAt,
    });
  if (!inserted) throw new Error("blueprint draft insert returned no row");

  return {
    success: true,
    value: { draftId: inserted.id, revision: inserted.revision, updatedAt: inserted.updatedAt },
  };
}

/**
 * ⚠️ THE UPDATE IS GUARDED ON THREE THINGS AT ONCE: the id, the OWNER, and the revision the client
 * loaded. So a stranger's draft, a nonexistent one and a stale write all produce the same zero rows
 * — and the service then reads once more to tell the last case apart, because "somebody else edited
 * this" is an answer the author can act on while the other two must stay indistinguishable.
 */
export async function replaceBlueprintDraft(input: {
  readonly ownerUserId: string;
  readonly draftId: string;
  readonly label: string | null;
  readonly document: string;
  readonly documentSchemaVersion: number;
  readonly revision: number;
}): Promise<Result<BlueprintDraftReceipt, BlueprintDraftError>> {
  if (!isJsonObject(input.document)) {
    return { success: false, error: { type: "BLUEPRINT_DRAFT_DOCUMENT_NOT_OBJECT" } };
  }

  const [updated] = await db
    .update(blueprintDraft)
    .set({
      label: input.label,
      documentJson: input.document,
      documentSchemaVersion: input.documentSchemaVersion,
      revision: input.revision + 1,
    })
    .where(
      and(
        eq(blueprintDraft.id, input.draftId),
        eq(blueprintDraft.ownerUserId, input.ownerUserId),
        eq(blueprintDraft.revision, input.revision),
      ),
    )
    .returning({
      id: blueprintDraft.id,
      revision: blueprintDraft.revision,
      updatedAt: blueprintDraft.updatedAt,
    });

  if (updated) {
    return {
      success: true,
      value: { draftId: updated.id, revision: updated.revision, updatedAt: updated.updatedAt },
    };
  }

  /*
   * Zero rows. Re-read UNDER THE OWNER PREDICATE so this second query cannot become the oracle the
   * first one refused to be: a draft belonging to somebody else is still "not found" here.
   */
  const [existing] = await db
    .select({ revision: blueprintDraft.revision })
    .from(blueprintDraft)
    .where(
      and(eq(blueprintDraft.id, input.draftId), eq(blueprintDraft.ownerUserId, input.ownerUserId)),
    )
    .limit(1);
  if (!existing) return { success: false, error: { type: "BLUEPRINT_DRAFT_NOT_FOUND" } };

  return {
    success: false,
    error: { type: "BLUEPRINT_DRAFT_REVISION_STALE", currentRevision: existing.revision },
  };
}

export async function listMyBlueprintDrafts(input: {
  readonly ownerUserId: string;
  readonly arm: BlueprintDraftArm | undefined;
}): Promise<readonly BlueprintDraftSummary[]> {
  const conditions = [eq(blueprintDraft.ownerUserId, input.ownerUserId)];
  if (input.arm !== undefined) conditions.push(eq(blueprintDraft.arm, input.arm));

  return db
    .select({
      draftId: blueprintDraft.id,
      arm: blueprintDraft.arm,
      label: blueprintDraft.label,
      revision: blueprintDraft.revision,
      updatedAt: blueprintDraft.updatedAt,
    })
    .from(blueprintDraft)
    .where(and(...conditions))
    .orderBy(desc(blueprintDraft.updatedAt), desc(blueprintDraft.id))
    .limit(MAX_BLUEPRINT_DRAFTS_PER_AUTHOR);
}

export async function getMyBlueprintDraft(input: {
  readonly ownerUserId: string;
  readonly draftId: string;
}): Promise<Result<BlueprintDraftView, BlueprintDraftError>> {
  const [row] = await db
    .select({
      draftId: blueprintDraft.id,
      arm: blueprintDraft.arm,
      label: blueprintDraft.label,
      revision: blueprintDraft.revision,
      updatedAt: blueprintDraft.updatedAt,
      document: blueprintDraft.documentJson,
      documentSchemaVersion: blueprintDraft.documentSchemaVersion,
    })
    .from(blueprintDraft)
    .where(
      and(eq(blueprintDraft.id, input.draftId), eq(blueprintDraft.ownerUserId, input.ownerUserId)),
    )
    .limit(1);

  // A stranger's draft and a nonexistent one are the same bytes.
  if (!row) return { success: false, error: { type: "BLUEPRINT_DRAFT_NOT_FOUND" } };
  return { success: true, value: row };
}

export async function deleteBlueprintDraft(input: {
  readonly ownerUserId: string;
  readonly draftId: string;
}): Promise<Result<{ readonly draftId: string }, BlueprintDraftError>> {
  const [deleted] = await db
    .delete(blueprintDraft)
    .where(
      and(eq(blueprintDraft.id, input.draftId), eq(blueprintDraft.ownerUserId, input.ownerUserId)),
    )
    .returning({ id: blueprintDraft.id });

  if (!deleted) return { success: false, error: { type: "BLUEPRINT_DRAFT_NOT_FOUND" } };
  return { success: true, value: { draftId: deleted.id } };
}
