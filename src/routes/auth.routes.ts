import express from "express";

import * as authController from "#src/controllers/auth.controller.js";
import * as recoveryController from "#src/controllers/recovery.controller.js";
import {
  otpRequestEmailLimiter,
  otpRequestIpLimiter,
  recoveryCompleteIpLimiter,
  recoveryStartEmailLimiter,
  recoveryStartIpLimiter,
  signupCompleteIpLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";

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
  authController.startSignup,
);

/**
 * POST /signup/complete
 * Phase 2 of signup — the only place an account is created: verifies the OTP and
 * sets the password atomically, then opens the session (public). Rate limited per-IP.
 */
router.post("/signup/complete", signupCompleteIpLimiter, authController.completeSignup);

/**
 * GET /me
 * The currently authenticated user, derived from the session cookie.
 */
router.get("/me", requireAuth, authController.getCurrentUser);

/**
 * POST /recovery/start
 * Account recovery phase 1 — email a reset code to a VERIFIED recovery email
 * (public; the user is locked out of their primary inbox). Always a generic 200
 * so it can't probe which recovery emails exist. Rate limited per-IP and
 * per-recovery-email.
 */
router.post(
  "/recovery/start",
  recoveryStartIpLimiter,
  recoveryStartEmailLimiter,
  recoveryController.startRecovery,
);

/**
 * POST /recovery/complete
 * Account recovery phase 2 — verify the code and set a new password on the primary
 * account, then revoke all sessions (public). Rate limited per-IP.
 */
router.post("/recovery/complete", recoveryCompleteIpLimiter, recoveryController.completeRecovery);

export default router;
