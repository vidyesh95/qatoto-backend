import { and, asc, desc, eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { optimizationSuggestion, optimizationSuggestionEvidence } from "#src/db/schema.js";
import type { ProjectAccessError } from "#src/modules/rnd/projects/project-membership.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Workflow optimization suggestions (R_AND_D_BACKEND_STRUCTURE.md §9.6, §11e).
 *
 * §9.1's LEFT COLUMN, in full: an analysis that a human reviews, accepts or dismisses.
 * Every row names what produced it and carries a lifecycle the mock lacks.
 *
 * **IT SUGGESTS; IT NEVER ALLOCATES.** Nothing in this file writes a slice, touches a
 * proposal, or moves a verdict — accepting a suggestion records a decision, it does not
 * change anybody's equity. That separation is the whole reason this table sits beside the
 * ledger rather than inside it.
 *
 * WHY `modelName` IS REQUIRED EVEN FOR A HUMAN-AUTHORED SUGGESTION. Provenance is the
 * contract on this side of the determinism boundary: every row must say what produced it.
 * A maintainer writing one names themselves as the source (`human`), which is a true and
 * checkable statement — rather than being allowed to leave the column empty and become
 * indistinguishable from an unattributed machine output.
 */

/** The provenance a maintainer-authored suggestion carries. */
export const HUMAN_AUTHORED_MODEL = "human";
export const HUMAN_AUTHORED_PROMPT_VERSION = "human-v1";

export type SuggestionStatus = (typeof optimizationSuggestion.$inferSelect)["status"];

export type OptimizationSuggestionError =
  | ProjectAccessError
  | { type: "SUGGESTION_NOT_FOUND"; suggestionId: string }
  | { type: "SUGGESTION_ALREADY_DECIDED"; status: SuggestionStatus };

export interface SuggestionView {
  readonly id: string;
  readonly memberId: string | null;
  readonly title: string;
  readonly bodyText: string;
  readonly status: SuggestionStatus;
  readonly modelName: string;
  readonly modelVersion: string | null;
  readonly promptVersion: string;
  readonly confidenceBps: number | null;
  readonly asOf: Date;
  readonly decidedByUserId: string | null;
  readonly decidedAt: Date | null;
  readonly decisionNote: string | null;
  readonly createdAt: Date;
  readonly evidence: readonly {
    readonly sequenceNumber: number;
    readonly label: string;
    readonly relatedClaimId: string | null;
  }[];
}

export interface CreateSuggestionInput {
  readonly title: string;
  readonly bodyText: string;
  readonly memberId?: string | undefined;
  readonly evidenceLabels: readonly string[];
}

/** `POST …/optimization-suggestions` — maintainer and above. */
export async function createSuggestion(
  context: { readonly projectId: string },
  input: CreateSuggestionInput,
): Promise<Result<SuggestionView, OptimizationSuggestionError>> {
  const created = await db.transaction(async (tx) => {
    const [suggestion] = await tx
      .insert(optimizationSuggestion)
      .values({
        projectId: context.projectId,
        memberId: input.memberId ?? null,
        title: input.title,
        bodyText: input.bodyText,
        status: "open",
        modelName: HUMAN_AUTHORED_MODEL,
        promptVersion: HUMAN_AUTHORED_PROMPT_VERSION,
        // NULL, not 0: a human did not offer a probability, and 0 would read as "certainly
        // wrong" (the same reasoning §8 applies to an absent chip confidence).
        confidenceBps: null,
        asOf: new Date(),
      })
      .returning({ id: optimizationSuggestion.id });

    if (!suggestion) {
      throw new Error("createSuggestion: insert returned no row");
    }

    if (input.evidenceLabels.length > 0) {
      await tx.insert(optimizationSuggestionEvidence).values(
        input.evidenceLabels.map((label, index) => ({
          suggestionId: suggestion.id,
          sequenceNumber: index + 1,
          label,
        })),
      );
    }

    return suggestion.id;
  });

  const view = await findSuggestion(context.projectId, created);
  if (!view) {
    throw new Error("createSuggestion: suggestion could not be read back");
  }
  return { success: true, value: view };
}

/** `GET …/optimization-suggestions` — open first, then decided, newest within each. */
export async function listSuggestions(
  projectId: string,
  options: { readonly status?: SuggestionStatus | undefined } = {},
): Promise<readonly SuggestionView[]> {
  const filters = [eq(optimizationSuggestion.projectId, projectId)];
  if (options.status !== undefined) {
    filters.push(eq(optimizationSuggestion.status, options.status));
  }

  const rows = await db
    .select({ id: optimizationSuggestion.id })
    .from(optimizationSuggestion)
    .where(and(...filters))
    // Ends in a unique column so two suggestions created in one millisecond never swap
    // between reads (§4c rule 4).
    .orderBy(desc(optimizationSuggestion.asOf), desc(optimizationSuggestion.id));

  const views = await Promise.all(rows.map((row) => findSuggestion(projectId, row.id)));
  return views.filter((view): view is SuggestionView => view !== null);
}

export async function findSuggestion(
  projectId: string,
  suggestionId: string,
): Promise<SuggestionView | null> {
  const [suggestion] = await db
    .select()
    .from(optimizationSuggestion)
    .where(
      and(
        eq(optimizationSuggestion.id, suggestionId),
        eq(optimizationSuggestion.projectId, projectId),
      ),
    );

  if (!suggestion) return null;

  const evidence = await db
    .select({
      sequenceNumber: optimizationSuggestionEvidence.sequenceNumber,
      label: optimizationSuggestionEvidence.label,
      relatedClaimId: optimizationSuggestionEvidence.relatedClaimId,
    })
    .from(optimizationSuggestionEvidence)
    .where(eq(optimizationSuggestionEvidence.suggestionId, suggestionId))
    .orderBy(asc(optimizationSuggestionEvidence.sequenceNumber));

  return { ...suggestion, evidence };
}

/**
 * `POST …/:id/accept` and `…/:id/dismiss` — one decision, recorded once.
 *
 * A decided suggestion is terminal. Re-deciding would let "we accepted this" and "we
 * dismissed this" both be true of the same row at different times with no record of the
 * first, and the point of the lifecycle is that the decision is auditable.
 */
export async function decideSuggestion(
  context: { readonly projectId: string },
  suggestionId: string,
  decision: "accepted" | "dismissed",
  decidedByUserId: string,
  decisionNote: string | null,
): Promise<Result<SuggestionView, OptimizationSuggestionError>> {
  const [existing] = await db
    .select({ status: optimizationSuggestion.status })
    .from(optimizationSuggestion)
    .where(
      and(
        eq(optimizationSuggestion.id, suggestionId),
        eq(optimizationSuggestion.projectId, context.projectId),
      ),
    );

  if (!existing) {
    return { success: false, error: { type: "SUGGESTION_NOT_FOUND", suggestionId } };
  }
  if (existing.status !== "open") {
    return {
      success: false,
      error: { type: "SUGGESTION_ALREADY_DECIDED", status: existing.status },
    };
  }

  await db
    .update(optimizationSuggestion)
    .set({
      status: decision,
      decidedByUserId,
      decidedAt: new Date(),
      decisionNote,
    })
    // Re-asserted inside the write: a concurrent decision would otherwise overwrite the
    // first one silently, and `optimization_suggestion_decision_ck` would still pass.
    .where(
      and(eq(optimizationSuggestion.id, suggestionId), eq(optimizationSuggestion.status, "open")),
    );

  const view = await findSuggestion(context.projectId, suggestionId);
  if (!view) {
    return { success: false, error: { type: "SUGGESTION_NOT_FOUND", suggestionId } };
  }
  return { success: true, value: view };
}
