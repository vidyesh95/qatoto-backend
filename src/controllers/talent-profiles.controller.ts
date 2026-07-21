import type { Request, Response } from "express";
import { z } from "zod";

import {
  respondDiscoveryError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/discovery-error-response.js";
import * as talentService from "#src/services/talent-profiles.service.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

/**
 * The opt-in talent directory (R_AND_D_BACKEND_STRUCTURE.md §11b).
 */

const TALENT_AVAILABILITIES = ["open_to_work", "open_to_offers", "unavailable"] as const;
const ROLE_COMMITMENTS = ["full_time", "part_time", "hobby"] as const;
const TALENT_SORTS = ["recent", "effort"] as const;

/** Bounds every money field well inside int4 while still allowing a large ask. */
const MAXIMUM_MONEY_IN_CENTS = 2_000_000_000;

/**
 * The applicant-side mirror of §5's CompensationStrandSchema — a DISCRIMINATED UNION on
 * `kind`, so an equity ask carrying a salary range is a parse error rather than a row a
 * CHECK constraint has to reject (CLAUDE.md §3.2).
 *
 * `currency` is ABSENT from every branch (§4b: no currency field in any request body — it
 * is server-owned on talent_profile, the same shape as product.currency). `earnedAsPolicy`
 * is absent too: an ASK does not get to name a payout mechanism. That belongs to the OFFER
 * side, because the escrow engine honours offers, not wishes.
 */
const TalentCompensationAskSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("salary"),
      salaryMinInCentsPerMonth: z.number().int().min(0).max(MAXIMUM_MONEY_IN_CENTS),
      salaryMaxInCentsPerMonth: z.number().int().min(0).max(MAXIMUM_MONEY_IN_CENTS).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("one_time"),
      oneTimeMinInCents: z.number().int().min(0).max(MAXIMUM_MONEY_IN_CENTS),
      oneTimeMaxInCents: z.number().int().min(0).max(MAXIMUM_MONEY_IN_CENTS).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("equity"),
      // An ASK, never a grant. Grants come solely from §9's ledger, and there is no
      // writable equity column anywhere in this schema.
      equityBasisPointsMin: z.number().int().min(0).max(10_000),
      equityBasisPointsMax: z.number().int().min(0).max(10_000).optional(),
    })
    .strict(),
]);

/**
 * PUT, not PATCH: the profile is a value object the owner replaces wholesale, which is the
 * only way "remove my equity ask" and "clear my location" are expressible.
 *
 * ABSENT BY CONSTRUCTION: `userId` (§13 — the row is keyed on req.user.id), `name`,
 * `avatarImageUrl`, `handle` (a PROJECTION of `user`; a copy drifts the moment someone
 * changes their photo), `isPublished` (a separate explicit action, so a listing can never
 * appear as a side effect of an edit), `currency` (server-owned), `verifiedEffortMinutes`
 * (§9's job owns it — §13: no body carries an hour count), and `isVerified` on a skill.
 */
export const TalentProfileSchema = z
  .object({
    headlineRole: z.string().trim().min(2).max(120),
    availability: z.enum(TALENT_AVAILABILITIES),
    commitment: z.enum(ROLE_COMMITMENTS).optional(),
    locationLabel: z.string().trim().max(120).nullable().optional(),
    regionId: z.uuid().nullable().optional(),
    bio: z.string().trim().max(2_000).nullable().optional(),
    // Canonical `discovery_skill` slugs, validated as a SUBSET server-side so an unknown
    // slug is a typed 422 naming the offenders and never silently creates taxonomy.
    skillSlugs: z.array(z.string().trim().min(1).max(60)).max(25).default([]),
    compensationAsks: z.array(TalentCompensationAskSchema).max(3).default([]),
  })
  .strict();

export type TalentProfileInput = z.infer<typeof TalentProfileSchema>;

export const ListTalentQuerySchema = z
  .object({
    commitment: z.enum(ROLE_COMMITMENTS).optional(),
    /**
     * Repeatable: `?skill=water-quality&skill=firmware`. Multiple values are ANDed, which
     * is what a row of filter chips means.
     */
    skill: z
      .union([z.string().trim().min(1).max(60), z.array(z.string().trim().min(1).max(60)).max(10)])
      .transform((value) => (Array.isArray(value) ? value : [value]))
      .optional(),
    availability: z.enum(TALENT_AVAILABILITIES).optional(),
    region: z.string().trim().min(1).max(60).optional(),
    sort: z.enum(TALENT_SORTS).default("recent"),
    page: z.coerce.number().int().min(1).max(500).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

/**
 * GET /discovery/talent.
 *
 * The ONLY §6 read behind `requireAuth`, and deliberately so: it is the only one that
 * returns other people's personal data — name, avatar, location, availability. A civic
 * aggregate is a different object from a scrapeable roster of people.
 */
export async function listTalent(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedQuery = ListTalentQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const page = await talentService.listTalentProfiles({
    commitment: parsedQuery.data.commitment,
    skillSlugs: parsedQuery.data.skill,
    availability: parsedQuery.data.availability,
    regionSlug: parsedQuery.data.region,
    sort: parsedQuery.data.sort,
    page: parsedQuery.data.page,
    limit: parsedQuery.data.limit,
  });

  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message: "Talent profiles retrieved successfully",
    data: [...page.rows],
    pagination: {
      page: parsedQuery.data.page,
      limit: parsedQuery.data.limit,
      total: page.total,
      totalPages: Math.ceil(page.total / parsedQuery.data.limit),
    },
  };
  res.status(200).json(response);
}

/**
 * GET /discovery/talent/me.
 *
 * Returns 200 with `data: null` when the caller has no profile — NOT 404. This is an
 * opt-in surface where "you have not opted in" is a normal successful state, and 404ing it
 * would force every client to treat an error status as success.
 */
export async function getMyTalentProfile(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const profile = await talentService.findMyTalentProfile(req.user.id);

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: profile ? "Talent profile retrieved successfully" : "No talent profile yet",
    data: profile,
  };
  res.status(200).json(response);
}

/** PUT /discovery/talent/me — wholesale replacement. First create always lands private. */
export async function putMyTalentProfile(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = TalentProfileSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const upsertResult = await talentService.upsertTalentProfile(req.user.id, parsedBody.data);
  if (!upsertResult.success) {
    respondDiscoveryError(res, upsertResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Talent profile saved successfully",
    data: upsertResult.value,
  };
  res.status(200).json(response);
}

/** DELETE /discovery/talent/me — leaves the directory entirely. */
export async function deleteMyTalentProfile(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const deleteResult = await talentService.deleteTalentProfile(req.user.id);
  if (!deleteResult.success) {
    respondDiscoveryError(res, deleteResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Talent profile removed successfully",
    data: deleteResult.value,
  };
  res.status(200).json(response);
}

/** POST /discovery/talent/me/publish — the gate is re-derived server-side. */
export async function publishMyTalentProfile(req: Request, res: Response): Promise<void> {
  await setPublished(req, res, true);
}

/** POST /discovery/talent/me/unpublish */
export async function unpublishMyTalentProfile(req: Request, res: Response): Promise<void> {
  await setPublished(req, res, false);
}

async function setPublished(req: Request, res: Response, shouldPublish: boolean): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const publishResult = await talentService.setTalentProfilePublished(req.user.id, shouldPublish);
  if (!publishResult.success) {
    respondDiscoveryError(res, publishResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: shouldPublish
      ? "Talent profile published to the directory"
      : "Talent profile removed from the directory",
    data: publishResult.value,
  };
  res.status(200).json(response);
}
