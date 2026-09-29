import { and, asc, count, eq, gt, inArray, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { blueprintRightsClaim, teardown, user } from "#src/db/schema.js";
import { decodeInstantCursor, encodeInstantCursor } from "#src/lib/instant-cursor.js";
import type { BlueprintRightsClaimTarget } from "#src/modules/home/blueprints/blueprint-rights-claim.schemas.js";
import { buildErrorWithoutQueryParameters } from "#src/modules/home/blueprints/blueprint-write-errors.js";
import { getTeardownClaimTargets } from "#src/modules/home/blueprints/teardown-public-read.service.js";
import { appendPlatformAuditEntry } from "#src/modules/platform/audit/platform-audit.service.js";
import type { PlatformStaffContext } from "#src/modules/platform/roles/platform-role.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Rights claims against a teardown: the intake, the moderator queue, and the dismissal.
 *
 * ⚠️ FILING A CLAIM MOVES NO STATE AND WRITES NO AUDIT ENTRY, for the three reasons
 * `blueprint-content-report.service.ts` gives about a report. A moderator reads it; if they act,
 * `applyVerb` names this claim on the flag or quarantine it caused and marks it `actioned`.
 *
 * ⚠️ IT IS NOT A STATUTORY FILING. Qatoto has designated no DMCA agent. Storing the claim changes
 * where it lands — a queue instead of an inbox — and nothing about what it is.
 *
 * ⚠️ THE CLAIMANT COLUMNS LEAVE THIS FILE THROUGH `listRightsClaimQueue` ONLY, which is behind
 * `moderate_content`. The teardown's publisher is never shown who claimed or what they wrote.
 *
 * ⚠️ EVERY WRITE HERE BINDS PERSONAL DATA — a name, an email, a sworn account — so a database fault
 * is re-thrown through `buildErrorWithoutQueryParameters` and never reaches the logger with its
 * parameters attached.
 */

export type BlueprintRightsClaimError =
  | { readonly type: "RIGHTS_CLAIM_TEARDOWN_NOT_FOUND" }
  | { readonly type: "RIGHTS_CLAIM_ON_OWN_TEARDOWN" }
  | { readonly type: "RIGHTS_CLAIM_TARGET_NOT_FOUND" }
  | { readonly type: "RIGHTS_CLAIM_ALREADY_OPEN" }
  | { readonly type: "RIGHTS_CLAIM_NOT_FOUND" }
  | { readonly type: "RIGHTS_CLAIM_ALREADY_RESOLVED" }
  | { readonly type: "RIGHTS_CLAIM_CURSOR_MALFORMED" };

export type BlueprintRightsClaimKind = "patent" | "trade_secret" | "copyright_cad" | "trademark";
export type BlueprintRightsClaimStatus = "open" | "actioned" | "dismissed";

/**
 * ⚠️ THE READABLE GATE, NOT THE LIST GATE. A quarantined teardown still accepts a claim: a second
 * rights holder may have a different objection from the first, and refusing them would let one
 * quarantine decide that one claim settles a row. `claim-targets` uses the same gate for the same
 * reason, which is what lets the target check below reuse it.
 */
const CLAIMABLE_TEARDOWN_STATES = ["published", "flagged", "quarantined"] as const;

const PERSONAL_DATA_WITHHELD_REASON =
  "they include a rights claimant's name, email and sworn account";

interface ResolvedClaimTarget {
  readonly targetKind: BlueprintRightsClaimTarget["kind"];
  readonly targetId: string | null;
  readonly targetTitleSnapshot: string;
}

/**
 * Checks the named document, file or part belongs to THIS teardown, and snapshots its title.
 *
 * ⚠️ AGAINST `getTeardownClaimTargets`, the same list the claimant's picker was built from. An id
 * from another teardown, or one invented in DevTools, is the same answer as a stale one: not here.
 */
async function resolveClaimTarget(
  slug: string,
  teardownTitle: string,
  target: BlueprintRightsClaimTarget,
): Promise<ResolvedClaimTarget | null> {
  if (target.kind === "whole_teardown") {
    return { targetKind: "whole_teardown", targetId: null, targetTitleSnapshot: teardownTitle };
  }

  const claimTargets = await getTeardownClaimTargets(slug);
  if (!claimTargets.success) return null;

  switch (target.kind) {
    case "document": {
      const document = claimTargets.value.documents.find(
        (candidate) => candidate.id === target.documentId,
      );
      return document
        ? { targetKind: "document", targetId: document.id, targetTitleSnapshot: document.title }
        : null;
    }
    case "manufacturing_file": {
      const manufacturingFile = claimTargets.value.manufacturingFiles.find(
        (candidate) => candidate.id === target.manufacturingFileId,
      );
      return manufacturingFile
        ? {
            targetKind: "manufacturing_file",
            targetId: manufacturingFile.id,
            targetTitleSnapshot: manufacturingFile.title,
          }
        : null;
    }
    case "part": {
      const part = claimTargets.value.parts.find((candidate) => candidate.id === target.partId);
      return part
        ? { targetKind: "part", targetId: part.id, targetTitleSnapshot: part.label }
        : null;
    }
    default: {
      const exhaustiveCheck: never = target;
      throw new Error(`Unhandled claim target: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export interface CreatedBlueprintRightsClaim {
  readonly claimId: string;
  readonly status: "open";
  readonly receivedAt: Date;
}

export async function createBlueprintRightsClaim(input: {
  readonly teardownSlug: string;
  readonly claimantUserId: string;
  readonly claimKind: BlueprintRightsClaimKind;
  readonly target: BlueprintRightsClaimTarget;
  readonly claimantFullName: string;
  readonly claimantOrganizationName: string | null;
  readonly claimantEmail: string;
  readonly relationshipToRightsHolder: string;
  readonly claimSubstance: string;
}): Promise<Result<CreatedBlueprintRightsClaim, BlueprintRightsClaimError>> {
  const [teardownRow] = await db
    .select({ id: teardown.id, title: teardown.title, authorUserId: teardown.authorUserId })
    .from(teardown)
    .where(
      and(
        eq(teardown.slug, input.teardownSlug),
        inArray(teardown.moderationState, [...CLAIMABLE_TEARDOWN_STATES]),
      ),
    )
    .limit(1);

  // A slug that is not claimable and a slug that never existed are the same bytes.
  if (!teardownRow) return { success: false, error: { type: "RIGHTS_CLAIM_TEARDOWN_NOT_FOUND" } };

  /*
   * ⚠️ SERVICE-ONLY, like the report rule it copies: the author id lives on the teardown, so no
   * CHECK on this table can express it. A publisher disputing their own survey withdraws it; they
   * do not swear a claim against it.
   */
  if (teardownRow.authorUserId !== null && teardownRow.authorUserId === input.claimantUserId) {
    return { success: false, error: { type: "RIGHTS_CLAIM_ON_OWN_TEARDOWN" } };
  }

  const resolvedTarget = await resolveClaimTarget(
    input.teardownSlug,
    teardownRow.title,
    input.target,
  );
  if (resolvedTarget === null) {
    return { success: false, error: { type: "RIGHTS_CLAIM_TARGET_NOT_FOUND" } };
  }

  /*
   * ⚠️ `onConflictDoNothing().returning()` RATHER THAN A PRE-CHECK, for the report service's reason:
   * the partial unique index is the real control, and a read-then-write races the double-submit.
   *
   * ⚠️ `sworn_at` IS THE SERVER'S INSTANT. The schema refused the body unless all three clauses
   * were accepted; when is not the client's to say.
   */
  const receivedAt = new Date();
  let inserted: { id: string }[];
  try {
    inserted = await db
      .insert(blueprintRightsClaim)
      .values({
        teardownId: teardownRow.id,
        claimantUserId: input.claimantUserId,
        claimKind: input.claimKind,
        targetKind: resolvedTarget.targetKind,
        targetId: resolvedTarget.targetId,
        targetTitleSnapshot: resolvedTarget.targetTitleSnapshot,
        claimantFullName: input.claimantFullName,
        claimantOrganizationName: input.claimantOrganizationName,
        claimantEmail: input.claimantEmail,
        relationshipToRightsHolder: input.relationshipToRightsHolder,
        claimSubstance: input.claimSubstance,
        swornAt: receivedAt,
        createdAt: receivedAt,
      })
      .onConflictDoNothing()
      .returning({ id: blueprintRightsClaim.id });
  } catch (error: unknown) {
    throw buildErrorWithoutQueryParameters(
      error,
      "rights claim intake",
      PERSONAL_DATA_WITHHELD_REASON,
    );
  }

  const claimId = inserted[0]?.id;
  if (claimId === undefined)
    return { success: false, error: { type: "RIGHTS_CLAIM_ALREADY_OPEN" } };

  return { success: true, value: { claimId, status: "open", receivedAt } };
}

/**
 * One claim as the moderator sees it.
 *
 * ⚠️ THE CLAIMANT FIELDS ARE NULL EXACTLY WHEN `claimantDetailsPurgedAt` IS SET — the retention
 * sweep removed them six years after the claim was resolved. `blueprint_rights_claim_purge_ck`
 * holds that in the database; the admin schema on the frontend discriminates on the timestamp.
 */
export interface BlueprintRightsClaimQueueItem {
  readonly claimId: string;
  readonly status: BlueprintRightsClaimStatus;
  readonly claimKind: BlueprintRightsClaimKind;
  readonly targetKind: BlueprintRightsClaimTarget["kind"];
  readonly targetId: string | null;
  readonly targetTitleSnapshot: string;
  readonly teardownId: string;
  readonly teardownSlug: string;
  readonly teardownTitle: string;
  readonly teardownModerationState: string;
  readonly claimantHandle: string | null;
  readonly claimantFullName: string | null;
  readonly claimantOrganizationName: string | null;
  readonly claimantEmail: string | null;
  readonly relationshipToRightsHolder: string | null;
  readonly claimSubstance: string | null;
  readonly swornAt: Date;
  readonly resolvedAt: Date | null;
  readonly resolutionNote: string | null;
  readonly claimantDetailsPurgedAt: Date | null;
  /** ⚠️ CONTEXT, NEVER A THRESHOLD — the report queue's rule. */
  readonly openClaimCountOnTeardown: number;
  readonly createdAt: Date;
}

export interface BlueprintRightsClaimQueuePage {
  readonly items: readonly BlueprintRightsClaimQueueItem[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

/**
 * `GET /blueprints/admin/rights-claims` — oldest first, keyset-paged.
 *
 * ⚠️ A SEPARATE ROUTE FROM `/admin/content-reports`, and the reason is this select list: it is the
 * only read in the router that carries a claimant's name and email, and widening the report queue to
 * carry them would put them in front of every reader-report card too.
 */
export async function listRightsClaimQueue(input: {
  readonly status: BlueprintRightsClaimStatus;
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly staff: PlatformStaffContext;
}): Promise<Result<BlueprintRightsClaimQueuePage, BlueprintRightsClaimError>> {
  void input.staff;

  const cursor = input.cursor === undefined ? null : decodeInstantCursor(input.cursor);
  if (input.cursor !== undefined && cursor === null) {
    return { success: false, error: { type: "RIGHTS_CLAIM_CURSOR_MALFORMED" } };
  }

  const conditions = [eq(blueprintRightsClaim.status, input.status)];
  if (cursor !== null) {
    conditions.push(
      gt(
        sql`(${blueprintRightsClaim.createdAt}, ${blueprintRightsClaim.id})`,
        sql`(${cursor.instant}, ${cursor.id})`,
      ),
    );
  }

  const rows = await db
    .select({
      claimId: blueprintRightsClaim.id,
      status: blueprintRightsClaim.status,
      claimKind: blueprintRightsClaim.claimKind,
      targetKind: blueprintRightsClaim.targetKind,
      targetId: blueprintRightsClaim.targetId,
      targetTitleSnapshot: blueprintRightsClaim.targetTitleSnapshot,
      teardownId: blueprintRightsClaim.teardownId,
      teardownSlug: teardown.slug,
      teardownTitle: teardown.title,
      teardownModerationState: teardown.moderationState,
      claimantHandle: user.handle,
      claimantFullName: blueprintRightsClaim.claimantFullName,
      claimantOrganizationName: blueprintRightsClaim.claimantOrganizationName,
      claimantEmail: blueprintRightsClaim.claimantEmail,
      relationshipToRightsHolder: blueprintRightsClaim.relationshipToRightsHolder,
      claimSubstance: blueprintRightsClaim.claimSubstance,
      swornAt: blueprintRightsClaim.swornAt,
      resolvedAt: blueprintRightsClaim.resolvedAt,
      resolutionNote: blueprintRightsClaim.resolutionNote,
      claimantDetailsPurgedAt: blueprintRightsClaim.claimantDetailsPurgedAt,
      createdAt: blueprintRightsClaim.createdAt,
    })
    .from(blueprintRightsClaim)
    // `teardown_id` is NOT NULL and cascades, so an inner join loses nothing.
    .innerJoin(teardown, eq(teardown.id, blueprintRightsClaim.teardownId))
    .leftJoin(user, eq(user.id, blueprintRightsClaim.claimantUserId))
    .where(and(...conditions))
    .orderBy(asc(blueprintRightsClaim.createdAt), asc(blueprintRightsClaim.id))
    .limit(input.limit + 1);

  const hasMore = rows.length > input.limit;
  const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
  const lastRow = pageRows.at(-1);

  // One query for the page's open counts; `inArray`, never a hand-bound array (see the report queue).
  const teardownIds = [...new Set(pageRows.map((row) => row.teardownId))];
  const openCounts = new Map<string, number>();
  if (teardownIds.length > 0) {
    const countRows = await db
      .select({ teardownId: blueprintRightsClaim.teardownId, openCount: count() })
      .from(blueprintRightsClaim)
      .where(
        and(
          eq(blueprintRightsClaim.status, "open"),
          inArray(blueprintRightsClaim.teardownId, teardownIds),
        ),
      )
      .groupBy(blueprintRightsClaim.teardownId);
    for (const row of countRows) openCounts.set(row.teardownId, row.openCount);
  }

  return {
    success: true,
    value: {
      items: pageRows.map((row) => ({
        ...row,
        openClaimCountOnTeardown: openCounts.get(row.teardownId) ?? 0,
      })),
      page: {
        nextCursor:
          hasMore && lastRow
            ? encodeInstantCursor({ instant: lastRow.createdAt, id: lastRow.claimId })
            : null,
        hasMore,
      },
    },
  };
}

/**
 * `POST /blueprints/admin/rights-claims/:claimId/dismiss`.
 *
 * ⚠️ DISMISSING RESTORES NOTHING, for the report dismissal's reason: undoing another moderator's
 * flag as a side effect of answering a claimant would overturn their decision without a record. A
 * moderator who wants the row back uses `restore`.
 */
export async function dismissBlueprintRightsClaim(input: {
  readonly claimId: string;
  readonly resolutionNote: string;
  readonly staff: PlatformStaffContext;
}): Promise<Result<{ readonly claimId: string }, BlueprintRightsClaimError>> {
  let outcome: { readonly kind: "missing" | "already_resolved" | "dismissed" };
  try {
    outcome = await db.transaction(async (transaction) => {
      const [existing] = await transaction
        .select({
          id: blueprintRightsClaim.id,
          status: blueprintRightsClaim.status,
          teardownId: blueprintRightsClaim.teardownId,
          targetKind: blueprintRightsClaim.targetKind,
        })
        .from(blueprintRightsClaim)
        .where(eq(blueprintRightsClaim.id, input.claimId))
        .for("update");

      if (!existing) return { kind: "missing" } as const;
      if (existing.status !== "open") return { kind: "already_resolved" } as const;

      const decidedAt = new Date();
      await transaction
        .update(blueprintRightsClaim)
        .set({
          status: "dismissed",
          resolvedByUserId: input.staff.staffUserId,
          resolvedAt: decidedAt,
          resolutionNote: input.resolutionNote,
        })
        .where(
          and(eq(blueprintRightsClaim.id, input.claimId), eq(blueprintRightsClaim.status, "open")),
        );

      await appendPlatformAuditEntry(transaction, {
        eventKind: "blueprint_rights_claim_dismissed",
        actorUserId: input.staff.staffUserId,
        actorRoleSnapshot: input.staff.platformRole,
        actionLabel: "Dismissed a rights claim about a teardown",
        targetLabel: `rights claim ${existing.id}`,
        /*
         * ⚠️ IDS AND FLAGS ONLY. The chain is hash-linked and kept forever; the claimant's name and
         * the note stay on the claim row, where the retention sweep can reach them.
         */
        payload: {
          rightsClaimId: existing.id,
          teardownId: existing.teardownId,
          claimTargetKind: existing.targetKind,
          hasResolutionNote: true,
        },
        occurredAt: decidedAt,
      });

      return { kind: "dismissed" } as const;
    });
  } catch (error: unknown) {
    throw buildErrorWithoutQueryParameters(
      error,
      "rights claim dismissal",
      "they include a moderator's free-text note about a rights claimant",
    );
  }

  switch (outcome.kind) {
    case "missing":
      return { success: false, error: { type: "RIGHTS_CLAIM_NOT_FOUND" } };
    case "already_resolved":
      return { success: false, error: { type: "RIGHTS_CLAIM_ALREADY_RESOLVED" } };
    case "dismissed":
      return { success: true, value: { claimId: input.claimId } };
    default: {
      const exhaustiveCheck: never = outcome.kind;
      throw new Error(`Unhandled dismissal outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
