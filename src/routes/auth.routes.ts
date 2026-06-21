import express from "express";

import * as authController from "#src/controllers/auth.controller.js";
import { requireAuth } from "#src/middleware/require-auth.js";

const router = express.Router();

/**
 * POST /signup/start
 * Phase 1 of signup — send a verification code. Creates NO account (public).
 */
router.post("/signup/start", authController.startSignup);

/**
 * POST /signup/complete
 * Phase 2 of signup — the only place an account is created: verifies the OTP and
 * sets the password atomically, then opens the session (public).
 */
router.post("/signup/complete", authController.completeSignup);

/**
 * GET /me
 * The currently authenticated user, derived from the session cookie.
 */
router.get("/me", requireAuth, authController.getCurrentUser);

export default router;
