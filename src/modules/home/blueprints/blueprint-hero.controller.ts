import type { Request, Response } from "express";

import {
  firstParam,
  respondBlueprintHeroSlideError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/home/blueprints/blueprint-error-response.js";
import * as blueprintHeroService from "#src/modules/home/blueprints/blueprint-hero.service.js";
import {
  CreateBlueprintHeroSlideSchema,
  ReorderBlueprintHeroSlidesSchema,
  UpdateBlueprintHeroSlideSchema,
} from "#src/modules/home/blueprints/blueprints.schemas.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * `GET /blueprints/hero-slides` — PUBLIC. No session, no rate limiter.
 *
 * Returns only live slides (active and inside their schedule window), already ordered.
 * The array order IS the contract; `position` is not in the payload.
 */
export async function listActiveHeroSlides(_req: Request, res: Response): Promise<void> {
  const slides = await blueprintHeroService.listActiveBlueprintHeroSlides();

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Blueprints hero slides retrieved successfully",
    data: { slides },
  };
  res.status(200).json(response);
}

/** `GET /blueprints/admin/hero-slides` — every slide, including retired and scheduled ones. */
export async function listHeroSlidesForStaff(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const listResult = await blueprintHeroService.listBlueprintHeroSlidesForStaff(req.user.id);
  if (!listResult.success) {
    respondBlueprintHeroSlideError(res, listResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Blueprints hero slides retrieved successfully",
    data: { slides: listResult.value },
  };
  res.status(200).json(response);
}

/**
 * `POST /blueprints/admin/hero-slides` (multipart/form-data, field `image`) — create.
 *
 * ONE ROUND TRIP, image and metadata together. A create-then-upload pair would leave an
 * image-less row in the admin list every time the second call failed, and a slide with no
 * image is not a slide.
 */
export async function createHeroSlide(req: Request, res: Response): Promise<void> {
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

  const parsed = CreateBlueprintHeroSlideSchema.safeParse(req.body);
  if (!parsed.success) {
    respondValidationFailed(res, parsed.error);
    return;
  }

  const createResult = await blueprintHeroService.createBlueprintHeroSlide(
    req.user.id,
    {
      title: parsed.data.title,
      // An absent multipart part means the admin left the link blank, which is a
      // decorative slide — not an error.
      destinationPath: parsed.data.destinationPath ?? null,
      // Absent means active — a slide an admin bothered to upload is one they mean to run.
      isActive: parsed.data.isActive !== "false",
      startsAt: parsed.data.startsAt === undefined ? null : new Date(parsed.data.startsAt),
      endsAt: parsed.data.endsAt === undefined ? null : new Date(parsed.data.endsAt),
    },
    req.file.buffer,
  );
  if (!createResult.success) {
    respondBlueprintHeroSlideError(res, createResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 201,
    message: "Blueprints hero slide created successfully",
    data: createResult.value,
  };
  res.status(201).json(response);
}

/** `PATCH /blueprints/admin/hero-slides/:slideId` — title, link, schedule, active flag. */
export async function updateHeroSlide(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsed = UpdateBlueprintHeroSlideSchema.safeParse(req.body);
  if (!parsed.success) {
    respondValidationFailed(res, parsed.error);
    return;
  }

  // `undefined` means "leave it alone" and `null` means "clear this" — two different edits,
  // so the ISO strings are converted without collapsing them.
  const { startsAt, endsAt, ...unchangedFields } = parsed.data;

  const updateResult = await blueprintHeroService.updateBlueprintHeroSlide(
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
    respondBlueprintHeroSlideError(res, updateResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Blueprints hero slide updated successfully",
    data: updateResult.value,
  };
  res.status(200).json(response);
}

/**
 * `PATCH /blueprints/admin/hero-slides/:slideId/image` (multipart/form-data, field `image`).
 *
 * PATCH rather than PUT for the same two reasons the promotional carousel uses it: it
 * matches the closest house precedent (`PATCH /users/me/photo`), and the frontend transport
 * `sendForm` admits only POST and PATCH for multipart.
 */
export async function replaceHeroSlideImage(req: Request, res: Response): Promise<void> {
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

  const replaceResult = await blueprintHeroService.replaceBlueprintHeroSlideImage(
    req.user.id,
    firstParam(req.params.slideId),
    req.file.buffer,
  );
  if (!replaceResult.success) {
    respondBlueprintHeroSlideError(res, replaceResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Blueprints hero slide image replaced successfully",
    data: replaceResult.value,
  };
  res.status(200).json(response);
}

/**
 * `PATCH /blueprints/admin/hero-slides/reorder` — set the whole display order.
 *
 * MUST be registered above `/:slideId` in the router, or "reorder" is captured as a slide
 * id and this handler never runs.
 */
export async function reorderHeroSlides(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsed = ReorderBlueprintHeroSlidesSchema.safeParse(req.body);
  if (!parsed.success) {
    respondValidationFailed(res, parsed.error);
    return;
  }

  const reorderResult = await blueprintHeroService.reorderBlueprintHeroSlides(
    req.user.id,
    parsed.data.slideIds,
  );
  if (!reorderResult.success) {
    respondBlueprintHeroSlideError(res, reorderResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Blueprints hero carousel reordered successfully",
    data: { slides: reorderResult.value },
  };
  res.status(200).json(response);
}

/** `DELETE /blueprints/admin/hero-slides/:slideId` — remove the slide and its image. */
export async function deleteHeroSlide(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const deleteResult = await blueprintHeroService.deleteBlueprintHeroSlide(
    req.user.id,
    firstParam(req.params.slideId),
  );
  if (!deleteResult.success) {
    respondBlueprintHeroSlideError(res, deleteResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Blueprints hero slide deleted successfully",
    data: deleteResult.value,
  };
  res.status(200).json(response);
}
