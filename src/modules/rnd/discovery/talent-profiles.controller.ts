import type { Request, Response } from "express";

import {
  firstParam,
  respondDiscoveryError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/rnd/discovery/discovery-error-response.js";
import {
  ListTalentQuerySchema,
  TalentProfileSchema,
} from "#src/modules/rnd/discovery/talent-profiles.schemas.js";
import * as talentService from "#src/modules/rnd/discovery/talent-profiles.service.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

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
 * GET /discovery/talent/:talentUserIdOrHandle — one published profile (§11j.2).
 *
 * `requireAuth`, matching the list rather than the rest of `/discovery`, and for the reason
 * stated there: this is the one §6 read family that returns other people's personal data.
 *
 * ROUTE ORDER IS LOAD-BEARING for this handler — see the declaration in
 * `discovery.routes.ts`. Declared above `/talent/me`, it would swallow the caller's own
 * profile read as a lookup of the handle "me".
 */
export async function getTalentProfile(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const talentUserIdOrHandle = firstParam(req.params.talentUserIdOrHandle ?? "");
  const found = await talentService.findPublishedTalentProfile(talentUserIdOrHandle);

  if (!found.success) {
    respondDiscoveryError(res, found.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Talent profile retrieved successfully",
    data: found.value,
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
