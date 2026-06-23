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
