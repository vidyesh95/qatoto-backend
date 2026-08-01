import type { Request, Response } from "express";
import { z } from "zod";

import {
  firstParam,
  respondPromotionalSlideError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/promotions-error-response.js";
import * as promotionsService from "#src/services/promotions.service.js";
import { MAX_PROMOTIONAL_SLIDES } from "#src/services/promotions.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * The home-page promotional carousel.
 *
 * ONE PUBLIC READ AND SIX ADMIN WRITES. The public read takes no session at all — a slide
 * is the same for every visitor, and requiring a session on the front page's data source
 * would cost a Better Auth round trip on the most-hit route on the site.
 *
 * Every admin route is gated by `manage_promotions` INSIDE the service, before any id is
 * read (see promotions.service.ts). The controller does not pre-check it: a second check
 * here would be a second place to get the ordering wrong.
 */

// --- Schemas. Declared and EXPORTED here; the OpenAPI body map imports them.

const DestinationKindSchema = z.enum(["internal_path", "external_url"]);

/**
 * The destination value's SHAPE only — length and emptiness.
 *
 * The real rules (no protocol-relative path, https only, no credentials) live in
 * `parsePromotionalDestination`, deliberately NOT here. Zod proves the request parses;
 * that module produces the canonical string to store and is the single place the
 * open-redirect logic exists. Duplicating it in a `.refine()` would create a second
 * copy to keep in sync, and the copy that drifted would be the security-relevant one.
 */
const DestinationValueSchema = z.string().trim().min(1).max(2048);

const AltTextSchema = z.string().trim().min(1).max(200);

/**
 * A schedule bound on the wire: an ISO 8601 string, parsed into a `Date` by the handler.
 *
 * `z.iso.datetime()` and NOT `z.coerce.date()`, matching every other datetime body field
 * here (funding, compensation, proof-of-effort). Two reasons, and the second is the one
 * that bites: a `z.date()` is an UNREPRESENTABLE TYPE for the OpenAPI emitter, so
 * `convertBodySchema` throws on it and the route silently loses its published body —
 * `openapi-rnd-bodies.test.ts` fails the build for exactly that.
 */
const ScheduleBoundSchema = z.iso.datetime();

/**
 * Multipart text parts arrive as STRINGS — multer does not type them, so `isActive` is the
 * literal "true" or "false" and the handler compares it.
 *
 * NOT `z.coerce.boolean()`, which follows JS truthiness: the string "false" coerces to
 * `true`, so an admin who unchecked the box would publish the slide anyway. And not a
 * `.transform()` either — a transform is unrepresentable to the OpenAPI emitter for the
 * same reason a date is.
 */
const MultipartBooleanSchema = z.enum(["true", "false"]);

export const CreatePromotionalSlideSchema = z
  .object({
    altText: AltTextSchema,
    destinationKind: DestinationKindSchema,
    destinationValue: DestinationValueSchema,
    isActive: MultipartBooleanSchema.optional(),
    startsAt: ScheduleBoundSchema.optional(),
    endsAt: ScheduleBoundSchema.optional(),
  })
  .strict();

/**
 * The metadata patch.
 *
 * `.strict()` is what refuses every server-owned field — `position`, `imageUrl`,
 * `imageWidthPx`, `createdAt`, `createdByUserId`. They are refused LOUDLY as
 * unrecognized keys rather than silently ignored, which is how an admin (or an attacker)
 * learns the field is not theirs to set.
 *
 * `startsAt` and `endsAt` are NULLABLE here but not optional-nullable-collapsed: `null`
 * means "clear this bound" and absent means "leave it alone". Those are different edits
 * and the service treats them differently.
 */
export const UpdatePromotionalSlideSchema = z
  .object({
    altText: AltTextSchema.optional(),
    destinationKind: DestinationKindSchema.optional(),
    destinationValue: DestinationValueSchema.optional(),
    isActive: z.boolean().optional(),
    startsAt: ScheduleBoundSchema.nullable().optional(),
    endsAt: ScheduleBoundSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (patch) => (patch.destinationKind === undefined) === (patch.destinationValue === undefined),
    {
      // A kind with no value cannot be validated, and a value with no kind cannot be
      // interpreted — "/store" is a fine path and a broken URL. Both or neither.
      message: "Send destinationKind and destinationValue together, or neither.",
    },
  )
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Send at least one field to change.",
  });

/**
 * The whole order, as a permutation. Not a per-slide position write — see
 * `reorderPromotionalSlides` for why a partial order is a mismatch rather than a partial
 * apply.
 */
export const ReorderPromotionalSlidesSchema = z
  .object({
    // BOTH bounds are load-bearing, not decoration. Without them the largest body this
    // schema can produce is unbounded, and `json-body-budget.test.ts` fails the route for
    // being capped below what its own schema allows. The array bound is the service's own
    // ceiling rather than a second number, so the two cannot drift; 64 is the per-id cap
    // because a uuid is 36 characters.
    slideIds: z.array(z.string().min(1).max(64)).min(1).max(MAX_PROMOTIONAL_SLIDES),
  })
  .strict();

// --- Handlers.

/**
 * `GET /promotions/slides` — PUBLIC. No session, no rate limiter.
 *
 * Returns only live slides (active and inside their schedule window), already ordered.
 * The array order IS the contract; `position` is not in the payload.
 */
export async function listActiveSlides(_req: Request, res: Response): Promise<void> {
  const slides = await promotionsService.listActivePromotionalSlides();

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Promotional slides retrieved successfully",
    data: { slides },
  };
  res.status(200).json(response);
}

/** `GET /promotions/admin/slides` — every slide, including retired and scheduled ones. */
export async function listSlidesForStaff(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const listResult = await promotionsService.listPromotionalSlidesForStaff(req.user.id);
  if (!listResult.success) {
    respondPromotionalSlideError(res, listResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Promotional slides retrieved successfully",
    data: { slides: listResult.value },
  };
  res.status(200).json(response);
}

/**
 * `POST /promotions/admin/slides` (multipart/form-data, field `image`) — create.
 *
 * ONE ROUND TRIP, image and metadata together. A create-then-upload pair would leave an
 * image-less row in the admin list every time the second call failed, and a slide with no
 * image is not a slide.
 */
export async function createSlide(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  if (!req.file) {
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "An image file is required (multipart field 'image').",
    });
    return;
  }

  const parsed = CreatePromotionalSlideSchema.safeParse(req.body);
  if (!parsed.success) {
    respondValidationFailed(res, parsed.error);
    return;
  }

  const createResult = await promotionsService.createPromotionalSlide(
    req.user.id,
    {
      altText: parsed.data.altText,
      destinationKind: parsed.data.destinationKind,
      destinationValue: parsed.data.destinationValue,
      // Absent means active — a slide an admin bothered to upload is one they mean to run.
      isActive: parsed.data.isActive !== "false",
      startsAt: parsed.data.startsAt === undefined ? null : new Date(parsed.data.startsAt),
      endsAt: parsed.data.endsAt === undefined ? null : new Date(parsed.data.endsAt),
    },
    req.file.buffer,
  );
  if (!createResult.success) {
    respondPromotionalSlideError(res, createResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 201,
    message: "Promotional slide created successfully",
    data: createResult.value,
  };
  res.status(201).json(response);
}

/** `PATCH /promotions/admin/slides/:slideId` — alt text, destination, schedule, active. */
export async function updateSlide(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsed = UpdatePromotionalSlideSchema.safeParse(req.body);
  if (!parsed.success) {
    respondValidationFailed(res, parsed.error);
    return;
  }

  // `undefined` means "leave it alone" and `null` means "clear this bound" — two different
  // edits, so the ISO string is converted without collapsing them.
  const { startsAt, endsAt, ...unchangedFields } = parsed.data;

  const updateResult = await promotionsService.updatePromotionalSlide(
    req.user.id,
    firstParam(req.params.slideId),
    {
      ...unchangedFields,
      ...(startsAt === undefined
        ? {}
        : { startsAt: startsAt === null ? null : new Date(startsAt) }),
      ...(endsAt === undefined ? {} : { endsAt: endsAt === null ? null : new Date(endsAt) }),
    },
  );
  if (!updateResult.success) {
    respondPromotionalSlideError(res, updateResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Promotional slide updated successfully",
    data: updateResult.value,
  };
  res.status(200).json(response);
}

/**
 * `PATCH /promotions/admin/slides/:slideId/image` (multipart/form-data, field `image`).
 *
 * The replace IS idempotent — a fixed Cloudinary public id means sending the same file
 * twice leaves one asset — so PUT would be defensible on semantics. PATCH wins on two
 * counts that matter more: it matches the closest house precedent (`PATCH /users/me/photo`),
 * and the frontend transport `sendForm` admits only POST and PATCH for multipart. Widening
 * a shared primitive for one route is a worse trade than the verb.
 */
export async function replaceSlideImage(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  if (!req.file) {
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "An image file is required (multipart field 'image').",
    });
    return;
  }

  const replaceResult = await promotionsService.replacePromotionalSlideImage(
    req.user.id,
    firstParam(req.params.slideId),
    req.file.buffer,
  );
  if (!replaceResult.success) {
    respondPromotionalSlideError(res, replaceResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Promotional slide image replaced successfully",
    data: replaceResult.value,
  };
  res.status(200).json(response);
}

/**
 * `PATCH /promotions/admin/slides/reorder` — set the whole display order.
 *
 * MUST be registered above `/:slideId` in the router, or "reorder" is captured as a slide
 * id and this handler never runs.
 */
export async function reorderSlides(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsed = ReorderPromotionalSlidesSchema.safeParse(req.body);
  if (!parsed.success) {
    respondValidationFailed(res, parsed.error);
    return;
  }

  const reorderResult = await promotionsService.reorderPromotionalSlides(
    req.user.id,
    parsed.data.slideIds,
  );
  if (!reorderResult.success) {
    respondPromotionalSlideError(res, reorderResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Promotional carousel reordered successfully",
    data: { slides: reorderResult.value },
  };
  res.status(200).json(response);
}

/** `DELETE /promotions/admin/slides/:slideId` — remove the slide and its image. */
export async function deleteSlide(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const deleteResult = await promotionsService.deletePromotionalSlide(
    req.user.id,
    firstParam(req.params.slideId),
  );
  if (!deleteResult.success) {
    respondPromotionalSlideError(res, deleteResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Promotional slide deleted successfully",
    data: deleteResult.value,
  };
  res.status(200).json(response);
}
