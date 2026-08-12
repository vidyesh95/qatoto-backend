import type { Request, Response } from "express";

import {
  firstParam,
  respondDiscoveryError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/discovery-error-response.js";
import {
  CreateDiscoveryRegionSchema,
  CreateDiscoverySkillSchema,
  UpdateDiscoveryRegionSchema,
  UpdateDiscoverySkillSchema,
} from "#src/schemas/discovery-vocabulary.schemas.js";
import * as vocabularyService from "#src/services/discovery-vocabulary.service.js";
import type { ApiResponse } from "#src/types/index.js";

/** GET /discovery/admin/skills — the full vocabulary, retired entries included (§11j.4). */
export async function listSkills(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const listed = await vocabularyService.listDiscoverySkillsForModerator(req.user.id);
  if (!listed.success) {
    respondDiscoveryError(res, listed.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Skills retrieved successfully",
    data: listed.value,
  };
  res.status(200).json(response);
}

/** POST /discovery/admin/skills — moderator (§11j.4). */
export async function createSkill(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = CreateDiscoverySkillSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const created = await vocabularyService.createDiscoverySkill(req.user.id, parsedBody.data);
  if (!created.success) {
    respondDiscoveryError(res, created.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 201,
    message: "Skill created",
    data: created.value,
  };
  res.status(201).json(response);
}

/** PATCH /discovery/admin/skills/:skillId — relabel, re-file, or retire (§11j.4). */
export async function updateSkill(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = UpdateDiscoverySkillSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const updated = await vocabularyService.updateDiscoverySkill(
    req.user.id,
    firstParam(req.params.skillId ?? ""),
    parsedBody.data,
  );

  if (!updated.success) {
    respondDiscoveryError(res, updated.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Skill updated",
    data: updated.value,
  };
  res.status(200).json(response);
}

/**
 * DELETE /discovery/admin/skills/:skillId — moderator (§11j.4).
 *
 * NOT the retirement path — that is `PATCH { isActive: false }`. This erases a typo nobody
 * has used, and `talent_profile_skill`'s `restrict` FK decides whether that is true.
 */
export async function deleteSkill(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const deleted = await vocabularyService.deleteDiscoverySkill(
    req.user.id,
    firstParam(req.params.skillId ?? ""),
  );

  if (!deleted.success) {
    respondDiscoveryError(res, deleted.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Skill deleted",
    data: deleted.value,
  };
  res.status(200).json(response);
}

/** GET /discovery/admin/regions — moderator (§11j.4). */
export async function listRegions(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const listed = await vocabularyService.listDiscoveryRegionsForModerator(req.user.id);
  if (!listed.success) {
    respondDiscoveryError(res, listed.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Regions retrieved successfully",
    data: listed.value,
  };
  res.status(200).json(response);
}

/** POST /discovery/admin/regions — moderator; `global` is not an accepted kind (§11j.4). */
export async function createRegion(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = CreateDiscoveryRegionSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const created = await vocabularyService.createDiscoveryRegion(req.user.id, parsedBody.data);
  if (!created.success) {
    respondDiscoveryError(res, created.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 201,
    message: "Region created",
    data: created.value,
  };
  res.status(201).json(response);
}

/** PATCH /discovery/admin/regions/:regionId — the display label only (§11j.4). */
export async function updateRegion(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = UpdateDiscoveryRegionSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const updated = await vocabularyService.updateDiscoveryRegionLabel(
    req.user.id,
    firstParam(req.params.regionId ?? ""),
    parsedBody.data.displayLabel,
  );

  if (!updated.success) {
    respondDiscoveryError(res, updated.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Region updated",
    data: updated.value,
  };
  res.status(200).json(response);
}

/**
 * DELETE /discovery/admin/regions/:regionId — moderator (§11j.4).
 *
 * Refused when anything cites it — including talent profiles, whose FK is `SET NULL` and so
 * would otherwise be silently blanked rather than protected.
 */
export async function deleteRegion(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const deleted = await vocabularyService.deleteDiscoveryRegion(
    req.user.id,
    firstParam(req.params.regionId ?? ""),
  );

  if (!deleted.success) {
    respondDiscoveryError(res, deleted.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Region deleted",
    data: deleted.value,
  };
  res.status(200).json(response);
}
