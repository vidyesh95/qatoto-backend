import type { Request, Response } from "express";

import {
  ChannelHandleParamSchema,
  ListChannelVideosQuerySchema,
} from "#src/modules/home/channels/channels.schemas.js";
import * as channelsService from "#src/modules/home/channels/channels.service.js";
import {
  firstParam,
  respondValidationFailed,
} from "#src/modules/home/engagement/engagement-error-response.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * The channel page's two reads.
 *
 * BOTH ARE OPTIONAL-AUTH, and NEITHER HANDLER CHECKS `req.user`. The page is public — that is
 * the whole point, since it is what every feed card links to — so there is no signed-out branch
 * to write. A signed-in viewer gets `isSubscribedToCreator` and the per-video `hasLiked` /
 * `hasSaved` flags embedded rather than as a second round trip; `req.user?.id ?? null` is the
 * only place the session is read.
 */

/** Both errors this surface can produce, mapped here rather than through the engagement mapper. */
function respondChannelError(res: Response, error: channelsService.ChannelError): void {
  switch (error.type) {
    case "CHANNEL_NOT_FOUND":
      // ONE 404 FOR TWO FACTS — no such handle, and a handle nobody has claimed. Splitting them
      // would make the status an oracle for which handles exist.
      res.status(404).json({ status: "error", statusCode: 404, message: "Channel not found." });
      return;
    case "CURSOR_MALFORMED":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "That page cursor is not one we issued.",
      });
      return;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled channel error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/** `GET /channels/:handle` — the header. */
export async function getChannel(req: Request, res: Response): Promise<void> {
  const parsedParams = ChannelHandleParamSchema.safeParse({
    handle: firstParam(req.params.handle ?? ""),
  });
  if (!parsedParams.success) {
    respondValidationFailed(res, parsedParams.error);
    return;
  }

  const profileResult = await channelsService.getChannelProfile({
    handle: parsedParams.data.handle,
    viewerUserId: req.user?.id ?? null,
  });
  if (!profileResult.success) {
    respondChannelError(res, profileResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Channel retrieved successfully",
    data: profileResult.value,
  };
  res.status(200).json(response);
}

/** `GET /channels/:handle/videos` — the grid, keyset-paginated. */
export async function listChannelVideos(req: Request, res: Response): Promise<void> {
  const parsedParams = ChannelHandleParamSchema.safeParse({
    handle: firstParam(req.params.handle ?? ""),
  });
  if (!parsedParams.success) {
    respondValidationFailed(res, parsedParams.error);
    return;
  }

  const parsedQuery = ListChannelVideosQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const listResult = await channelsService.listChannelVideos({
    handle: parsedParams.data.handle,
    viewerUserId: req.user?.id ?? null,
    limit: parsedQuery.data.limit,
    cursor: parsedQuery.data.cursor ?? null,
  });
  if (!listResult.success) {
    respondChannelError(res, listResult.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Channel videos retrieved successfully",
    data: listResult.value.rows,
    nextCursor: listResult.value.nextCursor,
  });
}
