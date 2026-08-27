import type { Request, Response } from "express";

import * as channelProfileService from "#src/modules/auth/users/channel-profile.service.js";
import { UpdateMyChannelProfileSchema } from "#src/modules/auth/users/users.schemas.js";
import { respondValidationFailed } from "#src/modules/rnd/projects/project-error-response.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * The caller's own channel description and links.
 *
 * BOTH HANDLERS ARE SELF-SCOPED: the user id comes from the session, never from the path or the
 * body. There is no `:userId` variant and there should not be one — editing somebody else's public
 * description is a moderation action, and moderation has its own surface.
 */

/** `requireAuth` guarantees `req.user`; this fails closed if the middleware is ever misordered. */
function requireSignedInUserId(req: Request, res: Response): string | null {
  if (req.user) return req.user.id;
  res.status(401).json({
    status: "error",
    statusCode: 401,
    message: "Please sign in.",
  } satisfies ApiResponse);
  return null;
}

export async function getMyChannelProfile(req: Request, res: Response): Promise<void> {
  const userId = requireSignedInUserId(req, res);
  if (!userId) return;

  const result = await channelProfileService.getMyChannelProfile(userId);
  if (!result.success) {
    res.status(404).json({
      status: "error",
      statusCode: 404,
      message: "Your account no longer exists.",
    } satisfies ApiResponse);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Channel profile retrieved.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function updateMyChannelProfile(req: Request, res: Response): Promise<void> {
  const userId = requireSignedInUserId(req, res);
  if (!userId) return;

  const parsedBody = UpdateMyChannelProfileSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const result = await channelProfileService.replaceMyChannelProfile(userId, parsedBody.data);
  if (!result.success) {
    res.status(404).json({
      status: "error",
      statusCode: 404,
      message: "Your account no longer exists.",
    } satisfies ApiResponse);
    return;
  }

  // IT ANSWERS THE SAVED STATE, re-read rather than echoed. The links come back with the order the
  // server assigned, so a client that reordered locally and a client that reloaded see the same
  // thing — and nobody has to trust that the request and the rows agree.
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Channel profile updated.",
    data: result.value,
  } satisfies ApiResponse);
}
