import express from "express";

import * as usersController from "#src/controllers/users.controller.js";
import { requireAuth } from "#src/middleware/require-auth.js";

const router = express.Router();

/**
 * GET /users
 * List all users.
 */
router.get("/", usersController.getUsers);

/**
 * PATCH /users/me
 * Update the authenticated caller's own display name. Auth required; the user id
 * is derived from the session cookie, not the request body. Declared before the
 * `/:id` route so "me" is never swallowed as an id param.
 */
router.patch("/me", requireAuth, usersController.updateMyProfile);

/**
 * GET /users/:id
 * Get a single user by ID.
 */
router.get("/:id", usersController.getUserById);

export default router;
