import type { Request, Response } from "express";

import {
  firstParam,
  respondPromotionalSlideError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/home/promotions/promotions-error-response.js";
import {
  CreatePromotionalSlideSchema,
  ReorderPromotionalSlidesSchema,
  UpdatePromotionalSlideSchema,
} from "#src/modules/home/promotions/promotions.schemas.js";
import * as promotionsService from "#src/modules/home/promotions/promotions.service.js";
import type { ApiResponse } from "#src/types/index.js";

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
