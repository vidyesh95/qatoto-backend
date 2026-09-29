import { and, asc, eq, ne } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { researchCategory } from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import type { Result } from "#src/types/index.js";

/**
 * The project taxonomy. A client-writable taxonomy is a spam surface, so anything a
 * user mints lands `pending` and is excluded from public filter facets until a platform
 * moderator approves it (§4a Layer 3, §5).
 */

export type ResearchCategoryError = { type: "CATEGORY_LABEL_TAKEN"; slug: string };

export interface ResearchCategoryView {
  readonly id: string;
  readonly slug: string;
  /**
   * The human name. Named `displayLabel` on the wire, not `label` (§15) — three clients
   * render it, and `label` reads like a form label rather than the name of a taxonomy
   * node. The COLUMN is still `label`; the alias is applied at the projection boundary.
   */
  readonly displayLabel: string;
  /** Which pin asset the §6 problem map renders for this category. */
  readonly pinIconKey: (typeof researchCategory.$inferSelect)["pinIconKey"];
  readonly status: (typeof researchCategory.$inferSelect)["status"];
  /**
   * The cross-country comparability domain, or NULL when no moderator has assigned one.
   * NULL is ordinary: the category still pins and clusters, it only stays out of the
   * country matrix.
   */
  readonly domain: (typeof researchCategory.$inferSelect)["domain"];
  /** Optional one-level nesting. NULL for a top-level category. */
  readonly parentCategoryId: string | null;
}

const CATEGORY_VIEW_COLUMNS = {
  id: researchCategory.id,
  slug: researchCategory.slug,
  displayLabel: researchCategory.label,
  pinIconKey: researchCategory.pinIconKey,
  status: researchCategory.status,
  domain: researchCategory.domain,
  parentCategoryId: researchCategory.parentCategoryId,
} as const;

/**
 * Slugifies a category label.
 *
 * This slug IS the de-duplication mechanism, because `research_category_slug_unq` is
 * declared on it: "Cold Chain", "cold chain" and "Cold-Chain" all fold to `cold-chain`,
 * so the second minter loses the race and gets a 409 rather than creating a near
 * duplicate. That is the opposite of `research_project.slug`, which auto-suffixes —
 * two projects may legitimately share a name, two categories may not.
 */
function slugifyCategoryLabel(label: string): string {
  return label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

/**
 * Lists categories. Defaults to `approved` only, which is what every public filter
 * facet must show — a pending, user-minted category appearing in the public taxonomy
 * would make the spam gate pointless.
 */
export async function listResearchCategories(
  status: (typeof researchCategory.$inferSelect)["status"] = "approved",
): Promise<readonly ResearchCategoryView[]> {
  return db
    .select(CATEGORY_VIEW_COLUMNS)
    .from(researchCategory)
    .where(eq(researchCategory.status, status))
    .orderBy(asc(researchCategory.label), asc(researchCategory.id));
}

/**
 * Mints a category from the wizard's step 1.
 *
 * `status` is server-owned and always `pending` here — it is absent from the request
 * schema, so `.strict()` rejects a client trying to self-approve. Uniqueness is
 * resolved by letting the INSERT race and translating 23505, never by a
 * check-then-insert (a TOCTOU race under concurrency).
 */
export async function createResearchCategory(
  label: string,
  createdByUserId: string,
): Promise<Result<ResearchCategoryView, ResearchCategoryError>> {
  const slug = slugifyCategoryLabel(label);

  if (slug.length === 0) {
    // A label of pure punctuation or emoji cannot produce a usable filter key.
    return { success: false, error: { type: "CATEGORY_LABEL_TAKEN", slug } };
  }

  try {
    const [created] = await db
      .insert(researchCategory)
      .values({ slug, label, status: "pending", createdByUserId })
      .returning(CATEGORY_VIEW_COLUMNS);

    if (!created) {
      throw new Error("createResearchCategory: insert returned no row");
    }
    return { success: true, value: created };
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      return { success: false, error: { type: "CATEGORY_LABEL_TAKEN", slug } };
    }
    throw error;
  }
}

/**
 * Records a platform moderator's decision on a user-minted category (§11b).
 *
 * The CAPABILITY CHECK IS THE CALLER'S JOB and must happen BEFORE this function is
 * reached — see discovery-moderation.service.ts. This function only knows how to write a
 * decision; putting the authorization here as well would give the rule two homes.
 *
 * Re-deciding an already-decided category is refused rather than treated as idempotent:
 * a second approval would stamp a new decision over the original moderator's, silently
 * rewriting who is accountable for it.
 */
export async function applyCategoryDecision(input: {
  readonly categoryId: string;
  readonly nextStatus: Extract<
    (typeof researchCategory.$inferSelect)["status"],
    "approved" | "rejected"
  >;
  readonly pinIconKey?: (typeof researchCategory.$inferSelect)["pinIconKey"];
  readonly domain?: NonNullable<(typeof researchCategory.$inferSelect)["domain"]>;
}): Promise<ResearchCategoryView | null> {
  const [updated] = await db
    .update(researchCategory)
    .set({
      status: input.nextStatus,
      // Only overwrite the pin when the moderator actually chose one — omitting it must
      // leave the existing value rather than resetting it to the column default.
      ...(input.pinIconKey === undefined ? {} : { pinIconKey: input.pinIconKey }),
      // Same rule for the domain: omitted means "not decided here", never "clear it".
      ...(input.domain === undefined ? {} : { domain: input.domain }),
    })
    .where(and(eq(researchCategory.id, input.categoryId), eq(researchCategory.status, "pending")))
    .returning(CATEGORY_VIEW_COLUMNS);

  return updated ?? null;
}

/** Reads a category's current moderation status, for the already-decided check. */
export async function findCategoryStatusById(
  categoryId: string,
): Promise<(typeof researchCategory.$inferSelect)["status"] | null> {
  const [row] = await db
    .select({ status: researchCategory.status })
    .from(researchCategory)
    .where(eq(researchCategory.id, categoryId));
  return row?.status ?? null;
}

/** Why a classification was refused. Each is a 422: the request is well-formed, the tree is not. */
export type CategoryClassificationInvalidReason =
  | "self_parent"
  | "parent_not_found"
  | "parent_not_approved"
  | "parent_is_nested"
  | "category_has_children"
  | "domain_mismatch";

type CategoryTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type CategoryClassificationResult =
  | { readonly kind: "not_found" }
  | { readonly kind: "not_approved"; readonly status: ResearchCategoryView["status"] }
  | { readonly kind: "invalid"; readonly reason: CategoryClassificationInvalidReason }
  | { readonly kind: "unchanged"; readonly category: ResearchCategoryView }
  | {
      readonly kind: "classified";
      readonly previous: Pick<ResearchCategoryView, "domain" | "parentCategoryId">;
      readonly category: ResearchCategoryView;
    };

/**
 * Sets an approved category's domain and parent, as a REPLACE of both (`null` clears).
 *
 * THE TREE IS ONE LEVEL DEEP, AND THAT IS WHAT MAKES A CYCLE UNWRITABLE. A parent must be
 * top-level and a child must have no children, so no chain longer than one edge can exist
 * and there is nothing to walk. Both rows are locked `FOR UPDATE` inside one transaction,
 * because two moderators nesting A under B and B under A at the same moment would each pass
 * the check against the other's pre-write state.
 *
 * A PARENT AND CHILD MAY NOT DISAGREE ON DOMAIN when both carry one. A child whose domain
 * differs from its parent's would roll up into one country-matrix column while being filed
 * under another, which is exactly the incomparability the domain exists to prevent. A NULL
 * on either side is allowed — assignment is incremental.
 *
 * The CAPABILITY CHECK is the caller's job, as with `applyCategoryDecision`. The caller also
 * owns the TRANSACTION, so the locks, the write and the audit entry commit together — pass the
 * `tx` that `recordPlatformAction` hands its work callback.
 */
export async function applyCategoryClassification(
  transaction: CategoryTransaction,
  input: {
    readonly categoryId: string;
    readonly domain: ResearchCategoryView["domain"];
    readonly parentCategoryId: string | null;
  },
): Promise<CategoryClassificationResult> {
  const [current] = await transaction
    .select(CATEGORY_VIEW_COLUMNS)
    .from(researchCategory)
    .where(eq(researchCategory.id, input.categoryId))
    .for("update");
  if (!current) return { kind: "not_found" };
  if (current.status !== "approved") return { kind: "not_approved", status: current.status };

  if (input.parentCategoryId !== null) {
    if (input.parentCategoryId === input.categoryId) {
      return { kind: "invalid", reason: "self_parent" };
    }
    const [parent] = await transaction
      .select({
        status: researchCategory.status,
        domain: researchCategory.domain,
        parentCategoryId: researchCategory.parentCategoryId,
      })
      .from(researchCategory)
      .where(eq(researchCategory.id, input.parentCategoryId))
      .for("update");
    if (!parent) return { kind: "invalid", reason: "parent_not_found" };
    if (parent.status !== "approved") return { kind: "invalid", reason: "parent_not_approved" };
    if (parent.parentCategoryId !== null) return { kind: "invalid", reason: "parent_is_nested" };
    if (input.domain !== null && parent.domain !== null && parent.domain !== input.domain) {
      return { kind: "invalid", reason: "domain_mismatch" };
    }

    const [anyChild] = await transaction
      .select({ id: researchCategory.id })
      .from(researchCategory)
      .where(eq(researchCategory.parentCategoryId, input.categoryId))
      .limit(1);
    if (anyChild) return { kind: "invalid", reason: "category_has_children" };
  }

  // A parent's new domain must not contradict a child that already carries a different one.
  if (input.domain !== null) {
    const [disagreeingChild] = await transaction
      .select({ id: researchCategory.id })
      .from(researchCategory)
      .where(
        and(
          eq(researchCategory.parentCategoryId, input.categoryId),
          ne(researchCategory.domain, input.domain),
        ),
      )
      .limit(1);
    if (disagreeingChild) return { kind: "invalid", reason: "domain_mismatch" };
  }

  if (current.domain === input.domain && current.parentCategoryId === input.parentCategoryId) {
    return { kind: "unchanged", category: current };
  }

  const [updated] = await transaction
    .update(researchCategory)
    .set({ domain: input.domain, parentCategoryId: input.parentCategoryId })
    .where(eq(researchCategory.id, input.categoryId))
    .returning(CATEGORY_VIEW_COLUMNS);
  if (!updated) {
    throw new Error("applyCategoryClassification: locked row vanished before update");
  }
  return {
    kind: "classified",
    previous: { domain: current.domain, parentCategoryId: current.parentCategoryId },
    category: updated,
  };
}
