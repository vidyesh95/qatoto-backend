import type { Request, Response } from "express";
import { z } from "zod";

import * as usersService from "#src/services/users.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * Display name a user is allowed to set. Trimmed first, then bounded 1–100 and
 * restricted to letters/marks plus spaces, apostrophes, hyphens and periods —
 * the value must START with a letter/mark so it can't be pure punctuation.
 * Unicode-aware (`\p{L}\p{M}`) so non-Latin names are accepted.
 */
const FullNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required.")
  .max(100, "Name must be at most 100 characters.")
  .regex(/^[\p{L}\p{M}][\p{L}\p{M} '.-]*$/u, "Name contains invalid characters.");

/**
 * Body for PATCH /users/me. `.strict()` rejects unknown keys — in particular any
 * client-sent `id`, which is ignored regardless (the id comes from the session).
 */
const UpdateMyProfileSchema = z.object({ fullName: FullNameSchema }).strict();

/**
 * GET /users
 * List all users.
 */
export async function getUsers(req: Request, res: Response): Promise<void> {
  const users = await usersService.getAllUsers();
  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Users retrieved successfully",
    data: users,
  };
  res.status(200).json(response);
}

/**
 * GET /users/:id
 * Get a single user by ID.
 */
export async function getUserById(req: Request, res: Response): Promise<void> {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  const user = await usersService.getUserById(id);

  if (!user) {
    res.status(404).json({
      status: "error",
      statusCode: 404,
      message: `User with id '${id}' not found`,
    });
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "User retrieved successfully",
    data: user,
  };
  res.status(200).json(response);
}

/**
 * PATCH /users/me
 * Set the authenticated user's display name. The id is taken from the
 * server-derived session (req.user, set by requireAuth) — never from the body,
 * so a caller can only ever rename themselves (CLAUDE.md §1.1).
 */
export async function updateMyProfile(req: Request, res: Response): Promise<void> {
  // requireAuth guarantees req.user; guard defensively to satisfy the type and
  // fail closed if the middleware is ever misordered.
  if (!req.user) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    });
    return;
  }

  const parsedBody = UpdateMyProfileSchema.safeParse(req.body);

  if (!parsedBody.success) {
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "Validation failed",
      errors: z.flattenError(parsedBody.error).fieldErrors,
    });
    return;
  }

  const updateResult = await usersService.updateUserName(req.user.id, parsedBody.data.fullName);

  if (!updateResult.success) {
    switch (updateResult.error.type) {
      case "USER_NOT_FOUND":
        res.status(404).json({
          status: "error",
          statusCode: 404,
          message: "Your account no longer exists.",
        });
        return;
      default: {
        const exhaustiveCheck: never = updateResult.error.type;
        throw new Error(`Unhandled update error: ${String(exhaustiveCheck)}`);
      }
    }
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Name updated successfully",
    data: updateResult.value,
  };
  res.status(200).json(response);
}

/**
 * PATCH /users/me/photo  (multipart/form-data, field `photo`)
 * Set the authenticated caller's profile photo. The id comes from the session
 * (req.user), never the body — a caller can only set their own photo (§1.1).
 * `uploadAvatarPhoto` middleware has already buffered + size-capped the file;
 * the service re-validates the actual image bytes server-side.
 */
export async function updateMyPhoto(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    });
    return;
  }

  if (!req.file) {
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "A photo file is required (multipart field 'photo').",
    });
    return;
  }

  const updateResult = await usersService.updateUserPhoto(req.user.id, req.file.buffer);

  if (!updateResult.success) {
    switch (updateResult.error.type) {
      case "NOT_AN_IMAGE":
        res.status(422).json({
          status: "error",
          statusCode: 422,
          message: "The uploaded file is not a valid image.",
        });
        return;
      case "UNSUPPORTED_FORMAT":
        res.status(422).json({
          status: "error",
          statusCode: 422,
          message: "Photo must be a JPEG, PNG or WebP image.",
        });
        return;
      case "DIMENSIONS_TOO_SMALL":
        res.status(422).json({
          status: "error",
          statusCode: 422,
          message: "Photo must be at least 64×64 pixels.",
        });
        return;
      case "DIMENSIONS_TOO_LARGE":
        res.status(422).json({
          status: "error",
          statusCode: 422,
          message: "Photo dimensions are too large.",
        });
        return;
      case "NOT_CONFIGURED":
        res.status(503).json({
          status: "error",
          statusCode: 503,
          message: "Photo uploads are not available right now.",
        });
        return;
      case "UPLOAD_FAILED":
      case "DELETE_FAILED":
        res.status(502).json({
          status: "error",
          statusCode: 502,
          message: "Could not store the photo. Please try again.",
        });
        return;
      case "USER_NOT_FOUND":
        res.status(404).json({
          status: "error",
          statusCode: 404,
          message: "Your account no longer exists.",
        });
        return;
      default: {
        const exhaustiveCheck: never = updateResult.error;
        throw new Error(`Unhandled photo update error: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Photo updated successfully",
    data: updateResult.value,
  };
  res.status(200).json(response);
}

/**
 * GET /users/me/linked-accounts
 * List the caller's linked providers (credential / google / github) with the
 * email each is linked as. The user id AND email come from the server-derived
 * session (req.user, set by requireAuth) — never the request — so a caller can
 * only ever read their own linked accounts (CLAUDE.md §1.1). Tokens are never
 * returned.
 */
export async function getLinkedAccounts(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    });
    return;
  }

  const linkedAccounts = await usersService.getLinkedAccounts(req.user.id, req.user.email);

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Linked accounts retrieved successfully",
    data: linkedAccounts,
  };
  res.status(200).json(response);
}

/**
 * DELETE /users/me/photo
 * Remove the caller's photo (Cloudinary asset + DB fields) and reset to the
 * no-photo placeholder. Clearing imageSource re-allows OAuth to seed a picture.
 */
export async function deleteMyPhoto(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    });
    return;
  }

  const deleteResult = await usersService.deleteUserPhoto(req.user.id);

  if (!deleteResult.success) {
    switch (deleteResult.error.type) {
      case "NOT_CONFIGURED":
        res.status(503).json({
          status: "error",
          statusCode: 503,
          message: "Photo uploads are not available right now.",
        });
        return;
      case "UPLOAD_FAILED":
      case "DELETE_FAILED":
        res.status(502).json({
          status: "error",
          statusCode: 502,
          message: "Could not remove the photo. Please try again.",
        });
        return;
      case "USER_NOT_FOUND":
        res.status(404).json({
          status: "error",
          statusCode: 404,
          message: "Your account no longer exists.",
        });
        return;
      default: {
        const exhaustiveCheck: never = deleteResult.error;
        throw new Error(`Unhandled photo delete error: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Photo removed successfully",
    data: deleteResult.value,
  };
  res.status(200).json(response);
}
