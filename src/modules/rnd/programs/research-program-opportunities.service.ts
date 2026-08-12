import { and, asc, desc, eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { researchProgramBranch, researchProgramProductOpportunity } from "#src/db/schema.js";
import type { ProgramAccessError } from "#src/modules/rnd/programs/research-program-access.service.js";
import type { Result } from "#src/types/index.js";

/**
 * §10 product opportunities — the bridge from open research back to the pipeline the rest
 * of R&D serves (R_AND_D_BACKEND_STRUCTURE.md §10, §11f).
 *
 * TWO MOCK STRINGS BECAME NUMBERS HERE, and both changes buy something:
 *
 *   `marketPotentialLabel: "$12B est. market"`  → `estimatedMarketSizeInCents`, **bigint**.
 *       `1200000000000` is 560× the int4 ceiling (§4b), so the column type is not a
 *       preference. The "$12B" rendering is a client locale decision (§1).
 *
 *   `readinessLabel: "Monetizable in 2–4 yrs"`  → `readinessMinMonths` + `readinessMaxMonths`.
 *       Two integers make the rail SORTABLE, which a sentence cannot be. "Monetizable now"
 *       is `0`–`0`, and it sorts first without a special case.
 *
 * WRITES ARE CREATOR-OR-STAFF, NOT OPEN. Unlike branches, papers and posts — where anyone
 * signed in may contribute — a market projection attributed to a program is a claim the
 * program is making about itself, and every contributor being able to publish one turns the
 * rail into an advertising surface. The authorization lives in the controller; this service
 * assumes it happened.
 */

export type ResearchProgramOpportunityError =
  | ProgramAccessError
  | { type: "BRANCH_NOT_FOUND"; branchId: string }
  | { type: "OPPORTUNITY_NOT_FOUND"; opportunityId: string }
  | { type: "READINESS_RANGE_INVALID" };

export interface ResearchProgramOpportunityView {
  readonly opportunityId: string;
  readonly productName: string;
  readonly productDescription: string;
  readonly derivedFromBranchId: string;
  /** Joined, so the rail can say WHICH research this comes from without a second read. */
  readonly derivedFromBranchTitle: string;
  readonly estimatedMarketSizeInCents: number;
  readonly readinessMinMonths: number;
  readonly readinessMaxMonths: number;
  readonly createdAt: Date;
}

/**
 * Ordered by market size, largest first.
 *
 * A deliberate choice rather than newest-first: this rail answers "what could this research
 * be worth", so the biggest claim belongs at the top where a reader can weigh it. Ends in a
 * unique column (§4c rule 4) so two equal projections never swap places between reads.
 */
export async function listProgramOpportunities(
  programId: string,
): Promise<readonly ResearchProgramOpportunityView[]> {
  return (
    db
      .select({
        opportunityId: researchProgramProductOpportunity.id,
        productName: researchProgramProductOpportunity.productName,
        productDescription: researchProgramProductOpportunity.productDescription,
        derivedFromBranchId: researchProgramProductOpportunity.derivedFromBranchId,
        derivedFromBranchTitle: researchProgramBranch.title,
        estimatedMarketSizeInCents: researchProgramProductOpportunity.estimatedMarketSizeInCents,
        readinessMinMonths: researchProgramProductOpportunity.readinessMinMonths,
        readinessMaxMonths: researchProgramProductOpportunity.readinessMaxMonths,
        createdAt: researchProgramProductOpportunity.createdAt,
      })
      .from(researchProgramProductOpportunity)
      // innerJoin: `derivedFromBranchId` is NOT NULL and `restrict`, so the branch is
      // guaranteed present. That guarantee is the point of the FK — an opportunity with no
      // research behind it is an unsourced market projection.
      .innerJoin(
        researchProgramBranch,
        eq(researchProgramBranch.id, researchProgramProductOpportunity.derivedFromBranchId),
      )
      .where(eq(researchProgramProductOpportunity.programId, programId))
      .orderBy(
        desc(researchProgramProductOpportunity.estimatedMarketSizeInCents),
        asc(researchProgramProductOpportunity.id),
      )
  );
}

/** Creates one. The branch must belong to the SAME program. */
export async function createProgramOpportunity(input: {
  readonly programId: string;
  readonly productName: string;
  readonly productDescription: string;
  readonly derivedFromBranchId: string;
  readonly estimatedMarketSizeInCents: number;
  readonly readinessMinMonths: number;
  readonly readinessMaxMonths: number;
  readonly createdByUserId: string;
}): Promise<Result<{ readonly opportunityId: string }, ResearchProgramOpportunityError>> {
  if (input.readinessMaxMonths < input.readinessMinMonths) {
    // The CHECK says the same thing; failing here names the fields rather than the
    // constraint, which is the difference between a fixable 422 and a confusing 500.
    return { success: false, error: { type: "READINESS_RANGE_INVALID" } };
  }

  const [branch] = await db
    .select({ id: researchProgramBranch.id })
    .from(researchProgramBranch)
    .where(
      and(
        eq(researchProgramBranch.id, input.derivedFromBranchId),
        // BOTH columns: a branch id from another program must be indistinguishable from a
        // nonexistent one, or this route confirms which branch ids exist elsewhere.
        eq(researchProgramBranch.programId, input.programId),
      ),
    );

  if (!branch) {
    return {
      success: false,
      error: { type: "BRANCH_NOT_FOUND", branchId: input.derivedFromBranchId },
    };
  }

  const [created] = await db
    .insert(researchProgramProductOpportunity)
    .values({
      programId: input.programId,
      derivedFromBranchId: input.derivedFromBranchId,
      productName: input.productName,
      productDescription: input.productDescription,
      estimatedMarketSizeInCents: input.estimatedMarketSizeInCents,
      readinessMinMonths: input.readinessMinMonths,
      readinessMaxMonths: input.readinessMaxMonths,
      createdByUserId: input.createdByUserId,
    })
    .returning({ id: researchProgramProductOpportunity.id });

  if (!created) throw new Error("createProgramOpportunity: insert returned no row");
  return { success: true, value: { opportunityId: created.id } };
}

/** Deletes one. Creator-or-staff, checked by the caller. */
export async function deleteProgramOpportunity(input: {
  readonly programId: string;
  readonly opportunityId: string;
}): Promise<Result<{ readonly deleted: true }, ResearchProgramOpportunityError>> {
  const deletedRows = await db
    .delete(researchProgramProductOpportunity)
    .where(
      and(
        eq(researchProgramProductOpportunity.id, input.opportunityId),
        eq(researchProgramProductOpportunity.programId, input.programId),
      ),
    )
    .returning({ id: researchProgramProductOpportunity.id });

  if (deletedRows.length === 0) {
    return {
      success: false,
      error: { type: "OPPORTUNITY_NOT_FOUND", opportunityId: input.opportunityId },
    };
  }
  return { success: true, value: { deleted: true } };
}
