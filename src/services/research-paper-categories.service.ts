import { and, asc, eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { researchPaperCategory } from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { recordPlatformAction } from "#src/services/platform-audit.service.js";
import {
  requirePlatformCapability,
  type PlatformAccessError,
} from "#src/services/platform-role.service.js";
import type { Result } from "#src/types/index.js";

/**
 * The §10 paper taxonomy — a deliberate near-copy of
 * `research-categories.service.ts`, which is the shape this codebase already settled on
 * for a client-mintable, moderator-approved lookup table.
 *
 * WHY A TABLE AND NOT A pgEnum. The mock this replaces had five hardcoded kebab-case
 * values living only in the frontend's TypeScript. §11f sends a `categoryId`, which means
 * a row — and it has to be a row, because the upload form lets a researcher propose a
 * category the platform has not thought of. A pgEnum would make every new research area a
 * migration.
 *
 * WHY NOT REUSE `research_category`. That table is the PROJECT taxonomy: its rows carry a
 * `pinIconKey` for the §6 problem map and drive project filter facets. "Cellular
 * Reprogramming" is not a kind of startup, and a shared table would put both vocabularies
 * in one namespace where a moderator approving one is approving the other.
 *
 * The status enum IS shared (`research_category_status`), because approved/pending/rejected
 * is the same three-state verdict and a fourth identical enum would be noise.
 */

export type ResearchPaperCategoryStatus = (typeof researchPaperCategory.$inferSelect)["status"];

export type ResearchPaperCategoryError =
  | { type: "PAPER_CATEGORY_LABEL_TAKEN"; slug: string }
  | { type: "PAPER_CATEGORY_NOT_FOUND"; categoryId: string }
  | { type: "PAPER_CATEGORY_ALREADY_DECIDED"; status: ResearchPaperCategoryStatus };

export interface ResearchPaperCategoryView {
  readonly id: string;
  readonly slug: string;
  /**
   * Named `displayLabel` on the wire though the column is `label`, matching
   * `ResearchCategoryView` — three clients render it, and `label` reads like a form label
   * rather than the name of a taxonomy node. The alias is applied here, at the projection
   * boundary, so list and create can never disagree about the shape.
   */
  readonly displayLabel: string;
  readonly status: ResearchPaperCategoryStatus;
}

const CATEGORY_VIEW_COLUMNS = {
  id: researchPaperCategory.id,
  slug: researchPaperCategory.slug,
  displayLabel: researchPaperCategory.label,
  status: researchPaperCategory.status,
} as const;

/** Lowercased, hyphenated, accent-stripped. The stable `?categoryId=` companion key. */
export function slugifyPaperCategoryLabel(label: string): string {
  return label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

/** Approved rows by default — the public facet. Ordered by label, then by a unique column. */
export async function listResearchPaperCategories(
  status: ResearchPaperCategoryStatus = "approved",
): Promise<readonly ResearchPaperCategoryView[]> {
  return db
    .select(CATEGORY_VIEW_COLUMNS)
    .from(researchPaperCategory)
    .where(eq(researchPaperCategory.status, status))
    .orderBy(asc(researchPaperCategory.label), asc(researchPaperCategory.id));
}

/**
 * Proposes a category. Lands `pending`.
 *
 * The unique index on `slug` IS the de-duplication: "Longevity Biology", "longevity
 * biology" and "Longevity-Biology" all slugify identically, so the second minter takes a
 * 23505 that becomes a 409. Never check-then-insert — that is a TOCTOU race, and letting
 * the database decide is the whole reason `isUniqueViolation` exists.
 *
 * Unlike a program slug this does NOT auto-suffix. Two taxonomy nodes meaning the same
 * thing is the failure being prevented; `longevity-biology-2` would BE that failure.
 */
export async function createResearchPaperCategory(
  label: string,
  createdByUserId: string,
): Promise<Result<ResearchPaperCategoryView, ResearchPaperCategoryError>> {
  const slug = slugifyPaperCategoryLabel(label);

  if (slug.length < 2) {
    // Punctuation or emoji only — cannot produce a usable filter key. Reported as
    // "taken" rather than growing a second error variant for a case a client fixes the
    // same way: type a real name.
    return { success: false, error: { type: "PAPER_CATEGORY_LABEL_TAKEN", slug } };
  }

  try {
    const [created] = await db
      .insert(researchPaperCategory)
      .values({ slug, label, status: "pending", createdByUserId })
      .returning(CATEGORY_VIEW_COLUMNS);

    if (!created) throw new Error("createResearchPaperCategory: insert returned no row");
    return { success: true, value: created };
  } catch (insertError: unknown) {
    if (isUniqueViolation(insertError)) {
      return { success: false, error: { type: "PAPER_CATEGORY_LABEL_TAKEN", slug } };
    }
    throw insertError;
  }
}

/** Resolves one row, whatever its status. The status read `decidePaperCategory` decides on. */
export async function findPaperCategoryById(
  categoryId: string,
): Promise<ResearchPaperCategoryView | null> {
  const [row] = await db
    .select(CATEGORY_VIEW_COLUMNS)
    .from(researchPaperCategory)
    .where(eq(researchPaperCategory.id, categoryId));

  return row ?? null;
}

/**
 * A moderator's verdict on a proposed category.
 *
 * Guards on `status = 'pending'` in the WHERE, so re-deciding returns null rather than
 * silently overwriting who was accountable for the first decision. The capability check
 * is the CALLER's job and must have already happened — see `platform-role.service.ts`.
 */
export async function applyPaperCategoryDecision(input: {
  readonly categoryId: string;
  readonly nextStatus: Extract<ResearchPaperCategoryStatus, "approved" | "rejected">;
}): Promise<ResearchPaperCategoryView | null> {
  const [updated] = await db
    .update(researchPaperCategory)
    .set({ status: input.nextStatus })
    .where(
      and(
        eq(researchPaperCategory.id, input.categoryId),
        eq(researchPaperCategory.status, "pending"),
      ),
    )
    .returning(CATEGORY_VIEW_COLUMNS);

  return updated ?? null;
}

export type PaperCategoryDecisionInput =
  | { readonly decision: "approve"; readonly note?: string }
  | { readonly decision: "reject"; readonly note: string };

/**
 * Approves or rejects a user-proposed paper category — the §6 `decideCategory` shape, applied
 * to the §10 taxonomy.
 *
 * THE ORDER OF CHECKS IS LOAD-BEARING: capability FIRST (403), resource SECOND (404).
 * Reversed, this route becomes an id oracle — anyone with a session could tell "that category
 * exists" from "it does not" by the status code without being staff at all.
 *
 * RE-DECIDING IS REFUSED, not idempotent. A second approval would stamp a new decision over
 * the first moderator's, silently rewriting who is accountable for letting a term into the
 * public taxonomy.
 *
 * THE AUDIT KINDS ARE SHARED WITH THE PROJECT TAXONOMY (`taxonomy_category_approved` /
 * `_rejected`) rather than minted anew, because a paper-specific pair would need a migration
 * to add an enum value. `targetLabel` and the payload carry which taxonomy it was, so the two
 * stay tellable apart in the log.
 */
export async function decidePaperCategory(
  actorUserId: string,
  categoryId: string,
  input: PaperCategoryDecisionInput,
): Promise<Result<ResearchPaperCategoryView, ResearchPaperCategoryError | PlatformAccessError>> {
  // 1. CAPABILITY FIRST — before any id is read.
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_taxonomy");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Resource second.
  const existing = await findPaperCategoryById(categoryId);
  if (existing === null) {
    return { success: false, error: { type: "PAPER_CATEGORY_NOT_FOUND", categoryId } };
  }
  if (existing.status !== "pending") {
    return {
      success: false,
      error: { type: "PAPER_CATEGORY_ALREADY_DECIDED", status: existing.status },
    };
  }

  const decidedAt = new Date();
  const updated = await recordPlatformAction(
    async () =>
      applyPaperCategoryDecision({
        categoryId,
        nextStatus: input.decision === "approve" ? "approved" : "rejected",
      }),
    (row) =>
      row === null
        ? // Lost the race with another moderator. Nothing was decided, so nothing is
          // recorded — an audit entry for a write that matched no row is a false trail.
          null
        : {
            eventKind:
              input.decision === "approve"
                ? "taxonomy_category_approved"
                : "taxonomy_category_rejected",
            actorUserId,
            actorRoleSnapshot: capabilityResult.value.platformRole,
            actionLabel:
              input.decision === "approve"
                ? "Approved a paper category"
                : "Rejected a paper category",
            targetLabel: `paper category ${categoryId}`,
            ...(input.note === undefined ? {} : { detailNote: input.note }),
            payload: { taxonomy: "research_paper_category", categoryId, decision: input.decision },
            occurredAt: decidedAt,
          },
  );

  if (!updated) {
    // Lost a race between the status read and the conditional UPDATE, which matched nothing.
    return {
      success: false,
      error: { type: "PAPER_CATEGORY_ALREADY_DECIDED", status: existing.status },
    };
  }

  return { success: true, value: updated };
}
