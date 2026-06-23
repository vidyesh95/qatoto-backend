import express from "express";

import * as usersController from "#src/controllers/users.controller.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { uploadAvatarPhoto } from "#src/middleware/upload-avatar.js";

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
 * PATCH /users/me/photo  (multipart/form-data, field `photo`)
 * Set the caller's own profile photo. Auth required; the file is buffered and
 * size-capped by uploadAvatarPhoto before the controller validates the bytes.
 */
router.patch("/me/photo", requireAuth, uploadAvatarPhoto, usersController.updateMyPhoto);

/**
 * DELETE /users/me/photo
 * Remove the caller's own profile photo and reset to the placeholder state.
 */
router.delete("/me/photo", requireAuth, usersController.deleteMyPhoto);

/**
 * GET /users/:id
 * Get a single user by ID.
 */
router.get("/:id", usersController.getUserById);

export default router;
