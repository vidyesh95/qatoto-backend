/**
 * §12 pitch handlers.
 *
 * NO SEPARATE AUTHORIZATION MIDDLEWARE, matching the programs module: visibility, ownership
 * and staff capability are all proven here, because middleware cannot return a `Result` and
 * so cannot participate in the exhaustive error switch.
 *
 * THE ORDERING RULE THAT MATTERS MOST: `resolveStaff` runs BEFORE any id or slug is read.
 * `PLATFORM_CAPABILITY_REQUIRED` is the one 403 on this surface, and it is only correct
 * while the caller has not been allowed to probe an id first. Reversing those two lines
 * turns a clean refusal into an existence oracle for unpublished pitches.
 */

import type { Request, Response } from "express";

import { requirePlatformCapability } from "#src/modules/platform/roles/platform-role.service.js";
import type { PlatformStaffContext } from "#src/modules/platform/roles/platform-role.service.js";
import { respondPitchError } from "#src/modules/rnd/pitches/pitch-error-response.js";
import {
  listPitchReviewQueue,
  moderatePitch,
} from "#src/modules/rnd/pitches/pitch-moderation.service.js";
import {
  confirmPitchOutcome,
  listPitchOutcomes,
  recordPitchOutcome,
} from "#src/modules/rnd/pitches/pitch-outcomes.service.js";
import {
  CreatePitchSchema,
  ListMyPitchesQuerySchema,
  ListPublicPitchesQuerySchema,
  ModeratePitchSchema,
  PitchPageQuerySchema,
  RecordPitchOutcomeSchema,
  UpdatePitchSchema,
} from "#src/modules/rnd/pitches/pitches.schemas.js";
import {
  closePitch,
  createPitch,
  deletePitch,
  findOwnedPitch,
  getPublicPitch,
  listMyPitches,
  listPublicPitches,
  listPublishedPitchSlugs,
  submitPitch,
  updatePitch,
} from "#src/modules/rnd/pitches/pitches.service.js";
// `optionalBody` is used ONLY by the PATCH. The three routes with a mandatory body read
// `req.body` directly, and that asymmetry is enforced by `openapi-rnd-bodies.test.ts`:
// `required` in the OpenAPI map is a property of the ROUTE, and the test proves it matches
// how the handler actually reads. Express 5 leaves `req.body` undefined for a bodyless POST,
// so reading it directly is what makes a bodyless create a 422 rather than a silent success.
import {
  firstParam,
  optionalBody,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/rnd/projects/project-error-response.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

function respondOk(res: Response, message: string, data: unknown): void {
  res.status(200).json({ status: "success", statusCode: 200, message, data } satisfies ApiResponse);
}

function respondCreated(res: Response, message: string, data: unknown): void {
  res.status(201).json({ status: "success", statusCode: 201, message, data } satisfies ApiResponse);
}

function respondPage(
  res: Response,
  message: string,
  page: number,
  limit: number,
  result: { readonly rows: readonly unknown[]; readonly total: number },
): void {
  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message,
    data: [...result.rows],
    pagination: {
      page,
      limit,
      total: result.total,
      totalPages: Math.ceil(result.total / limit),
    },
  };
  res.status(200).json(response);
}

/**
 * Proves the caller holds `moderate_content`.
 *
 * CAPABILITY FIRST, SLUG SECOND — see the file header. Nothing in this function reads a
 * route parameter, and that is the property that makes its 403 safe.
 */
async function resolveStaff(req: Request, res: Response): Promise<PlatformStaffContext | null> {
  if (!req.user) {
    respondUnauthenticated(res);
    return null;
  }
  const capabilityResult = await requirePlatformCapability(req.user.id, "moderate_content");
  if (!capabilityResult.success) {
    respondPitchError(res, capabilityResult.error);
    return null;
  }
  return capabilityResult.value;
}

// --- Founder writes --------------------------------------------------------

export async function createProjectPitch(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const parsedBody = CreatePitchSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const result = await createPitch(
    firstParam(req.params.projectSlug ?? ""),
    req.user.id,
    parsedBody.data,
  );
  if (!result.success) {
    respondPitchError(res, result.error);
    return;
  }
  respondCreated(
    res,
    "Pitch draft created. It is not public until a moderator reviews it.",
    result.value,
  );
}

export async function patchPitch(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const parsedBody = UpdatePitchSchema.safeParse(optionalBody(req));
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const result = await updatePitch(
    firstParam(req.params.pitchId ?? ""),
    req.user.id,
    parsedBody.data,
  );
  if (!result.success) {
    respondPitchError(res, result.error);
    return;
  }
  respondOk(res, "Pitch updated.", result.value);
}

export async function submitPitchForReview(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const result = await submitPitch(firstParam(req.params.pitchId ?? ""), req.user.id);
  if (!result.success) {
    respondPitchError(res, result.error);
    return;
  }
  // NOT "submitted and live". The verdict does not exist yet, and copy that implies one is
  // the same class of error as rendering a 202 as a result.
  respondOk(
    res,
    "Submitted for review. A moderator will decide whether it goes public.",
    result.value,
  );
}

export async function closePitchForFounder(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const result = await closePitch(firstParam(req.params.pitchId ?? ""), req.user.id);
  if (!result.success) {
    respondPitchError(res, result.error);
    return;
  }
  respondOk(
    res,
    "Pitch closed. Its page still resolves and says you are no longer raising.",
    result.value,
  );
}

export async function deletePitchDraft(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const result = await deletePitch(firstParam(req.params.pitchId ?? ""), req.user.id);
  if (!result.success) {
    respondPitchError(res, result.error);
    return;
  }
  respondOk(res, "Draft deleted.", result.value);
}

// --- Founder reads ---------------------------------------------------------

export async function getMyPitches(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const parsedQuery = ListMyPitchesQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }
  const { page, limit, status } = parsedQuery.data;
  const result = await listMyPitches(req.user.id, { page, limit, status });
  respondPage(res, "Your pitches loaded.", page, limit, result);
}

// --- Public reads ----------------------------------------------------------

export async function getPublicPitches(req: Request, res: Response): Promise<void> {
  const parsedQuery = ListPublicPitchesQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }
  const { page, limit, projectSlug } = parsedQuery.data;
  const result = await listPublicPitches({ page, limit, projectSlug });
  respondPage(res, "Pitches loaded.", page, limit, result);
}

export async function getPublishedPitchSlugs(_req: Request, res: Response): Promise<void> {
  const slugs = await listPublishedPitchSlugs();
  respondOk(res, "Pitch slugs loaded.", slugs);
}

/**
 * One pitch by slug, plus its funding record.
 *
 * `includeUnconfirmed` IS DERIVED FROM THE SESSION, never from a query parameter. Only the
 * founder sees one-sided claims; everybody else sees countersigned records only. A client
 * that could ask for unconfirmed rows could publish a raise nobody agreed to.
 */
export async function getPitchBySlug(req: Request, res: Response): Promise<void> {
  const result = await getPublicPitch(firstParam(req.params.pitchSlug ?? ""));
  if (!result.success) {
    respondPitchError(res, result.error);
    return;
  }

  const viewerUserId = req.user?.id;
  const isFounderViewing =
    viewerUserId !== undefined && (await findOwnedPitch(result.value.id, viewerUserId)).success;

  const outcomes = await listPitchOutcomes({
    pitchId: result.value.id,
    includeUnconfirmed: isFounderViewing,
  });

  respondOk(res, "Pitch loaded.", { pitch: result.value, outcomes });
}

// --- Outcomes --------------------------------------------------------------

export async function postPitchOutcome(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const parsedBody = RecordPitchOutcomeSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const result = await recordPitchOutcome({
    pitchId: firstParam(req.params.pitchId ?? ""),
    callerUserId: req.user.id,
    body: parsedBody.data,
  });
  if (!result.success) {
    respondPitchError(res, result.error);
    return;
  }

  // A REPLAY IS A 200, A NEW ROW IS A 201. The client can tell whether its retry created
  // anything, which is the whole point of returning `wasReplay` rather than hiding it.
  const message = result.value.wasReplay
    ? "Already recorded. This is the record your earlier request created."
    : "Recorded. It is your account of what happened until the other party confirms it.";
  if (result.value.wasReplay) {
    respondOk(res, message, result.value.outcome);
    return;
  }
  respondCreated(res, message, result.value.outcome);
}

export async function postOutcomeConfirmation(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const result = await confirmPitchOutcome({
    outcomeId: firstParam(req.params.outcomeId ?? ""),
    callerUserId: req.user.id,
  });
  if (!result.success) {
    respondPitchError(res, result.error);
    return;
  }
  respondOk(res, "Confirmed. Both parties now agree this is what happened.", result.value);
}

// --- Moderation ------------------------------------------------------------

export async function getPitchReviewQueue(req: Request, res: Response): Promise<void> {
  // Capability first — nothing below this line reads an id.
  const staff = await resolveStaff(req, res);
  if (!staff) return;

  const parsedQuery = PitchPageQuerySchema.strict().safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }
  const { page, limit } = parsedQuery.data;
  const result = await listPitchReviewQueue({ page, limit });
  respondPage(res, "Pitch review queue loaded.", page, limit, result);
}

export async function postPitchModeration(req: Request, res: Response): Promise<void> {
  const staff = await resolveStaff(req, res);
  if (!staff) return;

  const parsedBody = ModeratePitchSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const result = await moderatePitch({
    pitchId: firstParam(req.params.pitchId ?? ""),
    staff,
    decision: parsedBody.data,
  });
  if (!result.success) {
    respondPitchError(res, result.error);
    return;
  }
  respondOk(
    res,
    parsedBody.data.decision === "published" ? "Pitch published." : "Pitch rejected.",
    result.value,
  );
}
