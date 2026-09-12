import type { Request, Response } from "express";

import {
  firstParam,
  respondValidationFailed,
} from "#src/modules/home/blueprints/blueprint-error-response.js";
import * as teardownPublicReadService from "#src/modules/home/blueprints/teardown-public-read.service.js";
import {
  PublicTeardownIndexQuerySchema,
  PublicTeardownSlugSchema,
} from "#src/modules/home/blueprints/teardown-public.schemas.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * The five public teardown reads.
 *
 * NO SESSION IS READ ON ANY OF THEM, and that is deliberate rather than an omission: the payload is
 * identical for every visitor, so there is nothing to personalise and nothing to leak. What a
 * quarantine withholds is decided by the teardown's own state, never by who is asking —
 * `teardown-public-read.service.ts` holds that decision, and no handler here may reach around it.
 */

function respondOk(res: Response, message: string, data: unknown): void {
  res.status(200).json({ status: "success", statusCode: 200, message, data } satisfies ApiResponse);
}

/** A teardown that does not exist, or that a reader may not reach. Both get the same answer. */
function respondTeardownNotFound(res: Response): void {
  res.status(404).json({
    status: "error",
    statusCode: 404,
    message: "Teardown not found.",
  } satisfies ApiResponse);
}

/**
 * `GET /blueprints/teardowns` — the index, its filters and the tag counts beside it.
 *
 * THE FACETS RIDE ALONG rather than living on their own route, for the reason the showcase feed
 * gives: they are counted over the same population the list filters, and a second route could
 * answer 200 while this one failed — leaving chips that promise teardowns the list never shows.
 * It also collapses the frontend's two-call `Promise.all` into one request.
 */
export async function listPublicTeardowns(req: Request, res: Response): Promise<void> {
  const queryParse = PublicTeardownIndexQuerySchema.safeParse(req.query);
  if (!queryParse.success) {
    respondValidationFailed(res, queryParse.error);
    return;
  }

  const indexResult = await teardownPublicReadService.listPublicTeardowns({
    difficulty: queryParse.data.difficulty,
    media: queryParse.data.media,
    tag: queryParse.data.tag,
    limit: queryParse.data.limit,
    cursor: queryParse.data.cursor,
  });

  if (!indexResult.success) {
    // A cursor this server did not mint. Never a silent first page: a list that quietly restarts
    // shows the reader duplicates and reads as a backend bug.
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "Malformed cursor.",
    } satisfies ApiResponse);
    return;
  }

  respondOk(res, "Teardowns retrieved successfully", indexResult.value);
}

/**
 * `GET /blueprints/teardowns/options` — slug and title for the launch composer's select.
 *
 * The LIST gate, so the select cannot steer a maker toward a teardown under an open rights claim.
 */
export async function listTeardownOptions(_req: Request, res: Response): Promise<void> {
  const options = await teardownPublicReadService.listTeardownOptions();
  respondOk(res, "Teardown options retrieved successfully", options);
}

/**
 * `GET /blueprints/teardowns/slugs` — every readable slug, for the frontend's prerender step.
 *
 * ⚠️ THE READABLE GATE, so a quarantined teardown's slug IS here. Leaving it out would un-prerender
 * a page whose whole design is that the address keeps working while the files are withheld.
 */
export async function listPublicTeardownSlugs(_req: Request, res: Response): Promise<void> {
  const slugs = await teardownPublicReadService.listPublicTeardownSlugs();
  respondOk(res, "Teardown slugs retrieved successfully", slugs);
}

/**
 * `GET /blueprints/teardowns/:teardownSlug` — one readable teardown.
 *
 * A MALFORMED SLUG ANSWERS 404, NOT 422, and without touching the database. The parse runs, so the
 * boundary rule holds; only the status differs, because a 422 here beside a 404 for a well-formed
 * miss would together tell a stranger which slug shapes exist, one request at a time.
 *
 * A quarantined teardown answers 200 with its payload withheld — that is the design, not a
 * degradation, and the service decides it.
 */
export async function getPublicTeardown(req: Request, res: Response): Promise<void> {
  const slugParse = PublicTeardownSlugSchema.safeParse(firstParam(req.params.teardownSlug ?? ""));
  if (!slugParse.success) {
    respondTeardownNotFound(res);
    return;
  }

  const teardownResult = await teardownPublicReadService.getPublicTeardownBySlug(slugParse.data);
  if (!teardownResult.success) {
    respondTeardownNotFound(res);
    return;
  }

  respondOk(res, "Teardown retrieved successfully", teardownResult.value);
}

/**
 * `GET /blueprints/teardowns/:teardownSlug/claim-targets` — what a rights claim can name.
 *
 * ⚠️ IDS AND TITLES ONLY. This route exists because the detail read withholds a quarantined
 * teardown's files, and the report page builds its radio list out of them — a second rights holder
 * would otherwise be able to claim nothing narrower than "the whole teardown", which would use one
 * quarantine to blunt the control that produced it. The service's select lists carry no column that
 * could hold a URL, so this cannot become a way around the withholding.
 */
export async function getTeardownClaimTargets(req: Request, res: Response): Promise<void> {
  const slugParse = PublicTeardownSlugSchema.safeParse(firstParam(req.params.teardownSlug ?? ""));
  if (!slugParse.success) {
    respondTeardownNotFound(res);
    return;
  }

  const claimTargetsResult = await teardownPublicReadService.getTeardownClaimTargets(
    slugParse.data,
  );
  if (!claimTargetsResult.success) {
    respondTeardownNotFound(res);
    return;
  }

  respondOk(res, "Teardown claim targets retrieved successfully", claimTargetsResult.value);
}
