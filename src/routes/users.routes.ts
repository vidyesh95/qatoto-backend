import express from "express";

import * as handleController from "#src/controllers/handle.controller.js";
import * as recoveryEmailController from "#src/controllers/recovery-email.controller.js";
import * as usersController from "#src/controllers/users.controller.js";
import { recoveryEmailOtpLimiter } from "#src/middleware/rate-limit.js";
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
 * GET /users/me/handle
 * Panel bootstrap: the caller's current handle plus rate-limit + revert metadata.
 * Auth required; the user id comes from the session, never the request. Declared
 * before `/:id` so "me" is never swallowed as an id param.
 */
router.get("/me/handle", requireAuth, handleController.getMyHandle);

/**
 * PATCH /users/me/handle
 * Authoritative set/revert of the caller's handle (full server-side transaction).
 * Auth required; id from the session.
 */
router.patch("/me/handle", requireAuth, handleController.updateMyHandle);

/**
 * Recovery-email routes — the caller's BACKUP address, set/changed only with
 * step-up auth (a plain session is not enough). All session-guarded; id from the
 * session, never the body. Declared before `/:id` so "me" is never an id param.
 */

/**
 * GET /users/me/recovery-email
 * Settings-panel bootstrap: current recovery email + verification state.
 */
router.get("/me/recovery-email", requireAuth, recoveryEmailController.getMyRecoveryEmail);

/**
 * POST /users/me/recovery-email/step-up-challenge
 * Mail a step-up code to the caller's PRIMARY email (the path OAuth-only users
 * use, having no password). Rate-limited per-user alongside /start.
 */
router.post(
  "/me/recovery-email/step-up-challenge",
  requireAuth,
  recoveryEmailOtpLimiter,
  recoveryEmailController.sendStepUpChallenge,
);

/**
 * POST /users/me/recovery-email/start
 * Step 1: email an ownership-proving code to a NEW candidate recovery address.
 * Rate-limited per-user to stop inbox-bombing.
 */
router.post(
  "/me/recovery-email/start",
  requireAuth,
  recoveryEmailOtpLimiter,
  recoveryEmailController.startRecoveryEmail,
);

/**
 * POST /users/me/recovery-email/verify
 * Step 2: step-up proof + candidate code → store the recovery email as verified.
 */
router.post("/me/recovery-email/verify", requireAuth, recoveryEmailController.verifyRecoveryEmail);

/**
 * DELETE /users/me/recovery-email
 * Remove the recovery email (step-up gated).
 */
router.delete("/me/recovery-email", requireAuth, recoveryEmailController.deleteRecoveryEmail);

/**
 * GET /users/me/linked-accounts
 * The caller's linked providers (credential / google / github) and the email each
 * is linked as — drives the "Connected" rows in the settings panel. Auth required;
 * id + email come from the session, never the request. Declared before `/:id` so
 * "me" is never swallowed as an id param.
 */
router.get("/me/linked-accounts", requireAuth, usersController.getLinkedAccounts);

/**
 * GET /users/:id
 * Get a single user by ID.
 */
router.get("/:id", usersController.getUserById);

export default router;
