import type { Request, Response } from "express";
import { rateLimit, type Options } from "express-rate-limit";

import type { ApiResponse } from "#src/types/index.js";

/**
 * Rate limiters for the OTP signup endpoints.
 *
 * Better Auth's own rate limiter does NOT cover these routes: they call
 * `auth.api.*` server-side, and "server-side requests made using auth.api aren't
 * affected by rate limiting" (Better Auth docs). So these Express limiters are the
 * primary defense against OTP spam / email-bombing on our custom routes.
 *
 * Two independent angles guard /signup/start:
 *   - per-IP   → one client can't blast codes at many different inboxes.
 *   - per-email → one inbox can't be flooded with codes (anti-bomb), even via rotating IPs.
 */

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

/**
 * 429 response in the project's ApiResponse envelope, surfacing the retry delay.
 */
function rateLimitExceededHandler(_req: Request, res: Response): void {
  const retryAfterHeader = res.getHeader("Retry-After");
  const retryAfterSeconds =
    typeof retryAfterHeader === "string" ? Number(retryAfterHeader) : undefined;

  const response: ApiResponse<{ retryAfterSeconds?: number }> = {
    status: "error",
    statusCode: 429,
    message: "Too many requests. Please wait before trying again.",
    data: retryAfterSeconds !== undefined ? { retryAfterSeconds } : undefined,
  };
  res.status(429).json(response);
}

/**
 * Lowercased, trimmed email from the request body — the per-email bucket key.
 * Non-string/missing emails collapse to one shared bucket; those requests fail
 * validation in the controller anyway.
 */
function emailKey(req: Request): string {
  const rawEmail: unknown = req.body?.email;
  return typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
}

const sharedOptions = {
  windowMs: FIFTEEN_MINUTES_MS,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitExceededHandler,
} satisfies Partial<Options>;

/** /signup/start — at most 8 OTP-send requests per IP per 15 min. */
export const otpRequestIpLimiter = rateLimit({
  ...sharedOptions,
  limit: 8,
});

/** /signup/start — at most 4 OTP-send requests per email per 15 min. */
export const otpRequestEmailLimiter = rateLimit({
  ...sharedOptions,
  limit: 4,
  keyGenerator: emailKey,
});

/**
 * /signup/complete — at most 12 verify+create attempts per IP per 15 min.
 * Complements Better Auth's per-OTP `allowedAttempts` (3) guard on the code itself.
 */
export const signupCompleteIpLimiter = rateLimit({
  ...sharedOptions,
  limit: 12,
});
