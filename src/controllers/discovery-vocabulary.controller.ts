import type { Request, Response } from "express";
import { z } from "zod";

import {
  firstParam,
  respondDiscoveryError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/discovery-error-response.js";
import * as vocabularyService from "#src/services/discovery-vocabulary.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * The controlled-vocabulary admin surface — `/discovery/admin/skills` and `/regions`
 * (R_AND_D_BACKEND_STRUCTURE.md §6, §11j.4).
 *
 * ---------------------------------------------------------------------------
 * THE FIELDS THAT EXIST IN NO SCHEMA HERE, and are therefore 422s (§0, §13):
 *
 *   id · createdAt · isVerified (on a skill — job-written, and a badge a request could set
 *   would mean nothing) · slug on either PATCH · kind, countryCode and parentRegionId on the
 *   region PATCH.
 *
 * `slug` IS FROZEN ON BOTH PATCHES. It is the `?skill=` / `?region=` filter key matched by
 * equality — the structural fix §6 made — and clients have stored it in saved searches and
 * links. Renaming it silently breaks every one, which is the same reason `supplier.slug` and
 * a published `research_project.slug` are frozen.
 *
 * THE REGION PATCH ACCEPTS `displayLabel` AND NOTHING ELSE. `kind` and `countryCode` are
 * inputs to two cross-field CHECKs, so a partial edit re-creates the 23514-as-500 trap; and
 * `parentRegionId` is self-referential, so a re-parent is the one operation on this table
 * that could build a cycle. Freezing them makes both questions unrepresentable rather than
 * requiring a validation pass on every write.
 * ---------------------------------------------------------------------------
 */

const SlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Must be a lowercase, hyphen-separated slug");

const DisplayLabelSchema = z.string().trim().min(1).max(80);

export const CreateDiscoverySkillSchema = z
  .object({
    slug: SlugSchema,
    displayLabel: DisplayLabelSchema,
    categoryId: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

/** `isActive: false` is RETIREMENT — the row survives and profiles citing it keep rendering. */
export const UpdateDiscoverySkillSchema = z
  .object({
    displayLabel: DisplayLabelSchema.optional(),
    categoryId: z.string().trim().min(1).max(64).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

/**
 * `global` IS DELIBERATELY ABSENT from this enum.
 *
 * `discovery_region_root_ck` enforces `kind = 'global' ⇔ parent IS NULL`, but it does NOT
 * make `global` unique — so the schema's own assumption, "exactly one root, and it is the
 * global row", is enforced by nothing. Leaving the branch off the wire makes a second root
 * unrepresentable, which costs no query and no migration.
 *
 * The discriminated union carries both region CHECKs as types: `countryCode` exists only on
 * the `country` branch (so `.strict()` refuses it on a macro region and it is required on a
 * country), and `parentRegionId` is required on both (so neither can be a root).
 */
export const CreateDiscoveryRegionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("country"),
      slug: SlugSchema,
      displayLabel: DisplayLabelSchema,
      countryCode: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{2}$/, "Must be a two-letter ISO country code"),
      parentRegionId: z.string().trim().min(1).max(64),
    })
    .strict(),
  z
    .object({
      kind: z.literal("macro_region"),
      slug: SlugSchema,
      displayLabel: DisplayLabelSchema,
      parentRegionId: z.string().trim().min(1).max(64),
    })
    .strict(),
]);

/** A region's identity is not editable; only how it is displayed. */
export const UpdateDiscoveryRegionSchema = z.object({ displayLabel: DisplayLabelSchema }).strict();

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
