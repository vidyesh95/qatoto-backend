import type { Request, Response } from "express";
import type { ZodError } from "zod";

import {
  firstParam,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/project-error-response.js";
import {
  CofounderProfileIdParamsSchema,
  CofounderProfileSlugParamsSchema,
  ListCofounderProfilesQuerySchema,
  ListCofounderQueueQuerySchema,
  ModerateCofounderProfileSchema,
  SetEngagementStateSchema,
  WriteCofounderProfileSchema,
  type WriteCofounderProfileInput,
} from "#src/schemas/community-cofounder.schemas.js";
import * as communityCofounderService from "#src/services/community-cofounder.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * The cofounder directory's HTTP boundary (§18).
 *
 * NO SUCCESS MESSAGE HERE SAYS "LIVE", "LISTED" OR "YOU ARE NOW DISCOVERABLE" on a create.
 * `POST` answers `draft`; the profile is visible to nobody, including its author's own
 * public link, until a moderator publishes it.
 */

function sendZodError(res: Response, error: ZodError): void {
  respondValidationFailed(res, error);
}

function mapCofounderError(
  res: Response,
  error: communityCofounderService.CommunityCofounderError,
): void {
  switch (error.type) {
    case "NOT_FOUND":
      res.status(404).json({ status: "error", statusCode: 404, message: "Profile not found." });
      return;
    case "INVALID_CURSOR":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "The pagination cursor could not be read.",
      });
      return;
    case "INVALID_STATE":
      res.status(409).json({ status: "error", statusCode: 409, message: error.message });
      return;
    case "CONFLICT":
      res.status(409).json({ status: "error", statusCode: 409, message: error.message });
      return;
    case "NAME_UNUSABLE":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "This display name has no letters or digits to build a link from.",
        errors: { displayName: ["Use a name with at least three letters or digits."] },
      });
      return;
    /**
     * 409 AND NOT 422: the request is well-formed and would have succeeded a moment ago.
     * One profile per person is the rule that keeps anybody from listing somebody else.
     */
    case "PROFILE_EXISTS":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "You already have a cofounder profile. Edit that one instead.",
      });
      return;
    case "PLATFORM_CAPABILITY_REQUIRED":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "Moderating community content requires the moderator or admin role.",
        data: { capability: error.capability },
      });
      return;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled community cofounder error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/** The write body, normalized once so both create and update read the same shape. */
function toProfileWriteInput(
  body: WriteCofounderProfileInput,
): communityCofounderService.CofounderProfileWriteInput {
  return {
    displayName: body.displayName,
    headline: body.headline,
    bio: body.bio,
    lookingFor: body.lookingFor,
    countryCode: body.countryCode,
    avatarUrl: body.avatarUrl ?? null,
    commitmentLevel: body.commitmentLevel,
    contributionKinds: body.contributionKinds,
    sectors: body.sectors ?? [],
    languages: body.languages ?? [],
    priorVentures: (body.priorVentures ?? []).map((venture) => ({
      name: venture.name,
      roleLabel: venture.roleLabel,
      yearsActiveLabel: venture.yearsActiveLabel,
      outcomeSummary: venture.outcomeSummary ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

export async function listCofounderProfiles(req: Request, res: Response): Promise<void> {
  const query = ListCofounderProfilesQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }

  const result = await communityCofounderService.listCofounderProfiles(query.data);
  if (!result.success) {
    mapCofounderError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Cofounder profiles loaded.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function getCofounderProfile(req: Request, res: Response): Promise<void> {
  const params = CofounderProfileSlugParamsSchema.safeParse({
    profileSlug: firstParam(req.params.profileSlug),
  });
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }

  const result = await communityCofounderService.getCofounderProfileBySlug(params.data.profileSlug);
  if (!result.success) {
    mapCofounderError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Cofounder profile loaded.",
    data: result.value,
  } satisfies ApiResponse);
}

// ---------------------------------------------------------------------------
// The owner's lifecycle
// ---------------------------------------------------------------------------

export async function createCofounderProfile(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user) {
    respondUnauthenticated(res);
    return;
  }

  const body = WriteCofounderProfileSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await communityCofounderService.createCofounderProfile({
    userId: user.id,
    profile: toProfileWriteInput(body.data),
  });
  if (!result.success) {
    mapCofounderError(res, result.error);
    return;
  }

  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Draft profile created. Submit it when you are ready.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function getMyCofounderProfile(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user) {
    respondUnauthenticated(res);
    return;
  }

  const result = await communityCofounderService.getMyCofounderProfile(user.id);
  if (!result.success) {
    mapCofounderError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Your cofounder profile loaded.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function updateMyCofounderProfile(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user) {
    respondUnauthenticated(res);
    return;
  }

  const body = WriteCofounderProfileSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await communityCofounderService.updateMyCofounderProfile({
    userId: user.id,
    profile: toProfileWriteInput(body.data),
  });
  if (!result.success) {
    mapCofounderError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Profile updated.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function submitMyCofounderProfile(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user) {
    respondUnauthenticated(res);
    return;
  }

  const result = await communityCofounderService.submitMyCofounderProfile(user.id);
  if (!result.success) {
    mapCofounderError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Profile queued for review.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function withdrawMyCofounderProfile(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user) {
    respondUnauthenticated(res);
    return;
  }

  const result = await communityCofounderService.withdrawMyCofounderProfile(user.id);
  if (!result.success) {
    mapCofounderError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Profile withdrawn from the directory.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function setMyEngagementState(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user) {
    respondUnauthenticated(res);
    return;
  }

  const body = SetEngagementStateSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await communityCofounderService.setMyEngagementState({
    userId: user.id,
    engagementState: body.data.engagementState,
  });
  if (!result.success) {
    mapCofounderError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Availability updated.",
    data: result.value,
  } satisfies ApiResponse);
}

// ---------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------

export async function listCofounderModerationQueue(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user) {
    respondUnauthenticated(res);
    return;
  }

  const query = ListCofounderQueueQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }

  const result = await communityCofounderService.listCofounderModerationQueue({
    moderatorUserId: user.id,
    limit: query.data.limit,
    cursor: query.data.cursor,
  });
  if (!result.success) {
    mapCofounderError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Cofounder moderation queue loaded.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function moderateCofounderProfile(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user) {
    respondUnauthenticated(res);
    return;
  }

  const params = CofounderProfileIdParamsSchema.safeParse({
    profileId: firstParam(req.params.profileId),
  });
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = ModerateCofounderProfileSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await communityCofounderService.moderateCofounderProfile({
    moderatorUserId: user.id,
    profileId: params.data.profileId,
    decision: body.data.decision,
    reasonNote: body.data.reasonNote,
  });
  if (!result.success) {
    mapCofounderError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Profile decision recorded.",
    data: result.value,
  } satisfies ApiResponse);
}
