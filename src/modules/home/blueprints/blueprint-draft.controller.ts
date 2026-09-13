import type { Request, Response } from "express";

import { respondBlueprintDraftError } from "#src/modules/home/blueprints/blueprint-draft-error-response.js";
import {
  BlueprintDraftListQuerySchema,
  CreateBlueprintDraftSchema,
  ReplaceBlueprintDraftSchema,
} from "#src/modules/home/blueprints/blueprint-draft.schemas.js";
import * as blueprintDraftService from "#src/modules/home/blueprints/blueprint-draft.service.js";
import { respondUnauthenticated } from "#src/modules/home/blueprints/blueprint-error-response.js";
import { firstParam } from "#src/modules/home/blueprints/showcase-launch-error-response.js";
import { respondValidationFailed } from "#src/modules/home/blueprints/showcase-launch-error-response.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * `/blueprints/drafts` — the author's own unfinished work, and nobody else's.
 *
 * ⚠️ EVERY HANDLER HERE READS `req.user.id` AND PASSES IT AS THE OWNER. There is no admin variant
 * and no arm that takes an id without it: the ownership predicate is inside the query, not a check
 * around it, so a missing one is a 404 rather than a leak.
 */

function respondOk(res: Response, message: string, data: unknown): void {
  const response: ApiResponse = { status: "success", statusCode: 200, message, data };
  res.status(200).json(response);
}

export async function createDraft(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsed = CreateBlueprintDraftSchema.safeParse(req.body);
  if (!parsed.success) {
    respondValidationFailed(res, parsed.error);
    return;
  }

  const created = await blueprintDraftService.createBlueprintDraft({
    ownerUserId: req.user.id,
    arm: parsed.data.arm,
    label: parsed.data.label,
    document: parsed.data.document,
    documentSchemaVersion: parsed.data.documentSchemaVersion,
  });
  if (!created.success) {
    respondBlueprintDraftError(res, created.error);
    return;
  }

  // ⚠️ THREE SCALARS AND NO DOCUMENT. The client already has what it just sent.
  const response: ApiResponse = {
    status: "success",
    statusCode: 201,
    message: "Draft saved",
    data: created.value,
  };
  res.status(201).json(response);
}

export async function replaceDraft(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsed = ReplaceBlueprintDraftSchema.safeParse(req.body);
  if (!parsed.success) {
    respondValidationFailed(res, parsed.error);
    return;
  }

  const replaced = await blueprintDraftService.replaceBlueprintDraft({
    ownerUserId: req.user.id,
    draftId: firstParam(req.params.draftId ?? ""),
    label: parsed.data.label,
    document: parsed.data.document,
    documentSchemaVersion: parsed.data.documentSchemaVersion,
    revision: parsed.data.revision,
  });
  if (!replaced.success) {
    respondBlueprintDraftError(res, replaced.error);
    return;
  }

  respondOk(res, "Draft saved", replaced.value);
}

export async function listMyDrafts(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsed = BlueprintDraftListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    respondValidationFailed(res, parsed.error);
    return;
  }

  const drafts = await blueprintDraftService.listMyBlueprintDrafts({
    ownerUserId: req.user.id,
    arm: parsed.data.arm,
  });
  respondOk(res, "Drafts retrieved successfully", drafts);
}

export async function getMyDraft(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const draft = await blueprintDraftService.getMyBlueprintDraft({
    ownerUserId: req.user.id,
    draftId: firstParam(req.params.draftId ?? ""),
  });
  if (!draft.success) {
    respondBlueprintDraftError(res, draft.error);
    return;
  }

  respondOk(res, "Draft retrieved successfully", draft.value);
}

export async function deleteDraft(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const deleted = await blueprintDraftService.deleteBlueprintDraft({
    ownerUserId: req.user.id,
    draftId: firstParam(req.params.draftId ?? ""),
  });
  if (!deleted.success) {
    respondBlueprintDraftError(res, deleted.error);
    return;
  }

  respondOk(res, "Draft deleted", deleted.value);
}
