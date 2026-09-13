import type { Request, Response } from "express";

import { logger } from "#src/lib/logger.js";
import { computeBlueprintViewerFingerprint, utcDayStringOf } from "#src/lib/viewer-fingerprint.js";
import * as blueprintCommentsService from "#src/modules/home/blueprints/blueprint-comments.service.js";
import type { BlueprintCommentArm } from "#src/modules/home/blueprints/blueprint-comments.service.js";
import {
  firstParam,
  respondBlueprintCommentError,
  respondBlueprintEngagementError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/home/blueprints/blueprint-engagement-error-response.js";
import type { BlueprintEngagementArm } from "#src/modules/home/blueprints/blueprint-engagement-gate.js";
import {
  BlueprintViewerStateQuerySchema,
  CreateBlueprintCommentSchema,
  ListBlueprintCommentsQuerySchema,
  UpdateBlueprintCommentSchema,
} from "#src/modules/home/blueprints/blueprint-engagement.schemas.js";
import * as blueprintEngagementService from "#src/modules/home/blueprints/blueprint-engagement.service.js";
import type { BlueprintToggleVerb } from "#src/modules/home/blueprints/blueprint-engagement.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * The viewer-side write surface on `/blueprints`.
 *
 * ⚠️ THE ARM IS A ROUTE-TIME CONSTANT, NEVER A PARAMETER FROM THE WIRE. Each handler below is
 * produced by a factory that closes over its arm, so `/blueprints/teardowns/:slug/like` can only
 * ever reach the teardown tables. A `:targetKind` path segment would be a client-supplied value
 * deciding which table a write lands in — the shape CLAUDE.md §1.1 exists to refuse — and it would
 * also collide with the `/:teardownSlug` param route the router already declares.
 *
 * ⚠️ NOTHING HERE ECHOES A COUNT BACK FROM THE BEACON. The toggles do, because the client needs
 * the server's number to render instead of guessing; the beacon does not, because a live readout of
 * a counter is something an attacker can tune against.
 */

function respondOk(res: Response, message: string, data: unknown): void {
  res.status(200).json({ status: "success", statusCode: 200, message, data } satisfies ApiResponse);
}

/**
 * The per-day viewer key, derived once per request.
 *
 * ⚠️ ONE INSTANT, ONE DERIVATION. The same `utcDayString` is hashed AND written to
 * `view_day_bucket`; reading the clock twice would let a beacon landing on the stroke of midnight
 * be hashed under yesterday and filed under today, which silently starts a second session and
 * double-counts the view.
 */
function deriveViewerKey(req: Request): {
  readonly viewerUserId: string | null;
  readonly viewDayBucket: string;
  readonly viewerFingerprint: string;
} {
  const clientIp = req.ip;
  if (clientIp === undefined) {
    logger.warn("blueprint-engagement: no client ip on request, fingerprint degraded", {
      requestId: req.requestId,
      path: req.originalUrl,
    });
  }

  const viewerUserId = req.user?.id ?? null;
  const viewDayBucket = utcDayStringOf(new Date());

  return {
    viewerUserId,
    viewDayBucket,
    viewerFingerprint: computeBlueprintViewerFingerprint({
      utcDayString: viewDayBucket,
      viewerUserId,
      clientIp: clientIp ?? "",
      // Bounded before hashing: unbounded, this is an attacker-supplied input to a hash.
      userAgent: (req.headers["user-agent"] ?? "").slice(0, 512),
    }),
  };
}

/** `:launchSlug` / `:teardownSlug` / `:caseStudySlug`, whichever this route declared. */
function readSlugParam(req: Request, parameterName: string): string {
  return firstParam(req.params[parameterName] ?? "");
}

// ---------------------------------------------------------------------------
// The beacon
// ---------------------------------------------------------------------------

export function makeViewBeaconHandler(arm: BlueprintEngagementArm, parameterName: string) {
  return async function recordBlueprintView(req: Request, res: Response): Promise<void> {
    const slug = readSlugParam(req, parameterName);
    const viewerKey = deriveViewerKey(req);

    const result = await blueprintEngagementService.recordBlueprintView({
      arm,
      slug,
      viewerUserId: viewerKey.viewerUserId,
      viewerFingerprint: viewerKey.viewerFingerprint,
      viewDayBucket: viewerKey.viewDayBucket,
    });

    if (!result.success) {
      respondBlueprintEngagementError(res, result.error);
      return;
    }

    // 202 AND AN EMPTY BODY. See the file docblock: echoing the count is an oracle.
    res.status(202).end();
  };
}

// ---------------------------------------------------------------------------
// The toggles
// ---------------------------------------------------------------------------

export function makeToggleHandler(
  arm: BlueprintEngagementArm,
  verb: BlueprintToggleVerb,
  parameterName: string,
) {
  return async function setBlueprintToggle(req: Request, res: Response): Promise<void> {
    if (!req.user) {
      respondUnauthenticated(res);
      return;
    }

    const slug = readSlugParam(req, parameterName);
    /*
     * ⚠️ THE METHOD IS THE VERB'S DIRECTION, NOT A BODY FIELD. `PUT` sets and `DELETE` clears, so
     * there is no body to parse, no idempotency key to require, and a double-tap on a slow
     * connection is a no-op rather than a second row — the composite primary key does the rest.
     */
    const result = await blueprintEngagementService.setBlueprintToggle({
      arm,
      verb,
      slug,
      userId: req.user.id,
      isSet: req.method === "PUT",
    });

    if (!result.success) {
      respondBlueprintEngagementError(res, result.error);
      return;
    }

    respondOk(res, "Saved.", { isSet: result.value.isSet, count: result.value.count });
  };
}

// ---------------------------------------------------------------------------
// The batched viewer state
// ---------------------------------------------------------------------------

export async function getBlueprintViewerState(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedQuery = BlueprintViewerStateQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const state = await blueprintEngagementService.readBlueprintViewerState({
    userId: req.user.id,
    showcaseSlugs: parsedQuery.data.showcases,
    teardownSlugs: parsedQuery.data.teardowns,
    caseStudySlugs: parsedQuery.data.caseStudies,
  });

  respondOk(res, "Your engagement state.", state);
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export function makeListCommentsHandler(arm: BlueprintCommentArm, parameterName: string) {
  return async function listBlueprintComments(req: Request, res: Response): Promise<void> {
    const parsedQuery = ListBlueprintCommentsQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      respondValidationFailed(res, parsedQuery.error);
      return;
    }

    const result = await blueprintCommentsService.listBlueprintComments({
      arm,
      slug: readSlugParam(req, parameterName),
      parentCommentId: parsedQuery.data.parentCommentId ?? null,
      // `attachOptionalUser` may or may not have resolved one; the thread reads either way.
      viewerUserId: req.user?.id ?? null,
      limit: parsedQuery.data.limit,
      cursor: parsedQuery.data.cursor,
    });

    if (!result.success) {
      respondBlueprintCommentError(res, result.error);
      return;
    }

    respondOk(res, "The discussion.", result.value);
  };
}

export function makeCreateCommentHandler(arm: BlueprintCommentArm, parameterName: string) {
  return async function createBlueprintComment(req: Request, res: Response): Promise<void> {
    if (!req.user) {
      respondUnauthenticated(res);
      return;
    }

    const parsedBody = CreateBlueprintCommentSchema.safeParse(req.body);
    if (!parsedBody.success) {
      respondValidationFailed(res, parsedBody.error);
      return;
    }

    const result = await blueprintCommentsService.createBlueprintComment({
      arm,
      slug: readSlugParam(req, parameterName),
      authorUserId: req.user.id,
      bodyText: parsedBody.data.body,
      parentCommentId: parsedBody.data.parentCommentId,
    });

    if (!result.success) {
      respondBlueprintCommentError(res, result.error);
      return;
    }

    res.status(201).json({
      status: "success",
      statusCode: 201,
      message: "Posted.",
      data: result.value,
    } satisfies ApiResponse);
  };
}

export async function updateBlueprintComment(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = UpdateBlueprintCommentSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const result = await blueprintCommentsService.updateBlueprintComment({
    commentId: firstParam(req.params.commentId ?? ""),
    authorUserId: req.user.id,
    bodyText: parsedBody.data.body,
  });

  if (!result.success) {
    respondBlueprintCommentError(res, result.error);
    return;
  }

  respondOk(res, "Updated.", result.value);
}

export async function deleteBlueprintComment(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const result = await blueprintCommentsService.deleteBlueprintComment({
    commentId: firstParam(req.params.commentId ?? ""),
    authorUserId: req.user.id,
  });

  if (!result.success) {
    respondBlueprintCommentError(res, result.error);
    return;
  }

  respondOk(res, "Removed.", result.value);
}

export async function setBlueprintCommentLike(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const result = await blueprintCommentsService.setBlueprintCommentLike({
    commentId: firstParam(req.params.commentId ?? ""),
    userId: req.user.id,
    isSet: req.method === "PUT",
  });

  if (!result.success) {
    respondBlueprintCommentError(res, result.error);
    return;
  }

  respondOk(res, "Saved.", result.value);
}
