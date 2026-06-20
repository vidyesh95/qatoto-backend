import express from "express";

import * as authController from "#src/controllers/auth.controller.js";
import { requireAuth } from "#src/middleware/require-auth.js";

const router = express.Router();

/**
 * POST /set-initial-password
 * Phase 2 of OTP signup — set the first password for a credential-less user.
 * Behind requireAuth: the session cookie proves which user.
 */
router.post("/set-initial-password", requireAuth, authController.setInitialPassword);

/**
 * GET /me
 * The currently authenticated user, derived from the session cookie.
 */
router.get("/me", requireAuth, authController.getCurrentUser);

export default router;
