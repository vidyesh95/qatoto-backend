import express from "express";

import { compactBody } from "#src/middleware/json-body.js";
import {
  otpRequestEmailLimiter,
  otpRequestIpLimiter,
  signupCompleteIpLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import * as authController from "#src/modules/auth/session/auth.controller.js";

const router = express.Router();

/**
 * POST /signup/start
 * Phase 1 of signup — send a verification code. Creates NO account (public).
 * Rate limited per-IP and per-email to stop OTP spam / email-bombing.
 */
router.post(
  "/signup/start",
  otpRequestIpLimiter,
  otpRequestEmailLimiter,
  compactBody,
  authController.startSignup,
);

/**
 * POST /signup/complete
 * Phase 2 of signup — the only place an account is created: verifies the OTP and
 * sets the password atomically, then opens the session (public). Rate limited per-IP.
 */
router.post(
  "/signup/complete",
  signupCompleteIpLimiter,
  compactBody,
  authController.completeSignup,
);

/**
 * GET /me
 * The currently authenticated user, derived from the session cookie.
 */
router.get("/me", requireAuth, authController.getCurrentUser);

export default router;
