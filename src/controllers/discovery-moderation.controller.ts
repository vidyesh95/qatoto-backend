import type { Request, Response } from "express";
import { z } from "zod";

import {
  firstParam,
  respondDiscoveryError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/discovery-error-response.js";
import * as moderationService from "#src/services/discovery-moderation.service.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

/**
 * Platform-staff moderation for §6 (R_AND_D_BACKEND_STRUCTURE.md §11b).
 *
 * THE CAPABILITY CHECK LIVES IN THE SERVICE, not in middleware and not here. Middleware
 * cannot return a `Result`, so it could not participate in the exhaustive error switch
 * below — it would have to write a response or throw, which puts an authorization decision
 * outside the one place that maps domain errors to statuses (§4a, CLAUDE.md §3.2/§3.3).
 *
 * The service also checks the capability BEFORE reading any id, which is what stops these
 * routes from becoming id oracles.
 */

const CATEGORY_PIN_ICON_KEYS = [
  "water",
  "energy",
  "health",
  "agriculture",
  "housing",
  "transport",
  "waste",
  "connectivity",
  "manufacturing",
  "education",
  "other",
] as const;

/**
 * A DISCRIMINATED UNION on `decision`, not `{ decision, note? }`.
 *
 * `note` is genuinely REQUIRED on a reject — a rejection with no reason is unactionable
 * for the minter and unauditable for the next moderator — and genuinely optional on an
 * approve. A shared optional `note` cannot express that difference; the union makes the
 * illegal state unrepresentable (CLAUDE.md §3.2).
 *
 * `pinIconKey` extends §11b's `{ decision, note? }` by one key, deliberately: the icon is
 * moderator-owned metadata and approval is the exact moment it is assigned. It is absent
 * from the reject branch, and absent from the public CreateCategorySchema, so a minter can
 * never choose their own map iconography.
 */
export const DecideCategorySchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("approve"),
      pinIconKey: z.enum(CATEGORY_PIN_ICON_KEYS).optional(),
      note: z.string().trim().max(2_000).optional(),
    })
    .strict(),
  z
    .object({
      decision: z.literal("reject"),
      note: z.string().trim().min(1).max(2_000),
    })
    .strict(),
]);

export const DecideMergeProposalSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    note: z.string().trim().max(2_000).optional(),
  })
  .strict();

export const ListMergeProposalsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(500).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

/** POST /discovery/admin/categories/:categoryId/decide */
export async function decideCategory(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = DecideCategorySchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const decideResult = await moderationService.decideCategory(
    req.user.id,
    firstParam(req.params.categoryId ?? ""),
    parsedBody.data,
  );
  if (!decideResult.success) {
    respondDiscoveryError(res, decideResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Category decision recorded",
    data: decideResult.value,
  };
  res.status(200).json(response);
}

/** GET /discovery/admin/merge-proposals — the moderator queue. */
export async function listMergeProposals(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedQuery = ListMergeProposalsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const listResult = await moderationService.listPendingMergeProposals(req.user.id, {
    page: parsedQuery.data.page,
    limit: parsedQuery.data.limit,
  });
  if (!listResult.success) {
    respondDiscoveryError(res, listResult.error);
    return;
  }

  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message: "Merge proposals retrieved successfully",
    data: [...listResult.value.rows],
    pagination: {
      page: parsedQuery.data.page,
      limit: parsedQuery.data.limit,
      total: listResult.value.total,
      totalPages: Math.ceil(listResult.value.total / parsedQuery.data.limit),
    },
  };
  res.status(200).json(response);
}

/**
 * POST /discovery/admin/merge-proposals/:proposalId/decide.
 *
 * Approval is IRREVERSIBLE: the source cluster's submissions are repointed and the source
 * is marked `merged`. The target's distinct-reporter count is RE-DERIVED rather than
 * added, because the two clusters almost certainly share reporters.
 */
export async function decideMergeProposal(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = DecideMergeProposalSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const decideResult = await moderationService.decideMergeProposal(
    req.user.id,
    firstParam(req.params.proposalId ?? ""),
    parsedBody.data,
  );
  if (!decideResult.success) {
    respondDiscoveryError(res, decideResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Merge proposal decision recorded",
    data: decideResult.value,
  };
  res.status(200).json(response);
}
