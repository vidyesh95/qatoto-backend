import type { Request, Response } from "express";
import { z } from "zod";

import { auth } from "#src/lib/auth.js";
import * as recoveryEmailService from "#src/services/recovery-email.service.js";
import type { StepUpCredential } from "#src/services/recovery-email.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * A recovery email, normalized to the canonical form we store (trimmed,
 * lowercased) before validation. `.transform` runs after format checking.
 */
const RecoveryEmailField = z
  .email("A valid email is required.")
  .transform((email) => email.trim().toLowerCase());

/** Body for POST /users/me/recovery-email/start. `.strict()` rejects unknown keys. */
const StartRecoveryEmailSchema = z.object({ recoveryEmail: RecoveryEmailField }).strict();

/**
 * The step-up proof shape, shared by verify + delete. At least one of the two
 * credentials must be present — a plain session is never enough to change the
 * recovery email (CLAUDE.md §1.1). Both `.optional()` + a `.refine()` models
 * "exactly one path, your choice" without allowing neither.
 */
const stepUpFields = {
  stepUpPassword: z.string().min(1).optional(),
  stepUpOtp: z.string().min(1).optional(),
};
const hasOneStepUp = (data: { stepUpPassword?: string; stepUpOtp?: string }): boolean =>
  data.stepUpPassword !== undefined || data.stepUpOtp !== undefined;
const STEP_UP_REQUIRED = {
  message: "Step-up verification is required (password or primary-email code).",
  path: ["stepUpPassword"],
};

/** Body for POST /users/me/recovery-email/verify. */
const VerifyRecoveryEmailSchema = z
  .object({ otp: z.string().min(1, "Verification code is required."), ...stepUpFields })
  .strict()
  .refine(hasOneStepUp, STEP_UP_REQUIRED);

/** Body for DELETE /users/me/recovery-email. */
const ClearRecoveryEmailSchema = z
  .object(stepUpFields)
  .strict()
  .refine(hasOneStepUp, STEP_UP_REQUIRED);

/** Emit a 422 validation-failure envelope from a Zod parse error. */
function respondValidationFailed(
  res: Response,
  fieldErrors: Record<string, string[] | undefined>,
): void {
  res.status(422).json({
    status: "error",
    statusCode: 422,
    message: "Validation failed",
    errors: fieldErrors,
  });
}

/** 401 "please sign in" — used when req.user is somehow absent (misordered middleware). */
function respondUnauthenticated(res: Response): void {
  res.status(401).json({ status: "error", statusCode: 401, message: "Please sign in." });
}

/** Build the discriminated step-up credential from a validated body. */
function toStepUpCredential(data: {
  stepUpPassword?: string;
  stepUpOtp?: string;
}): StepUpCredential {
  if (data.stepUpPassword !== undefined) {
    return { kind: "password", password: data.stepUpPassword };
  }
  if (data.stepUpOtp !== undefined) {
    return { kind: "otp", otp: data.stepUpOtp };
  }
  // Unreachable: the schema's `.refine()` guarantees one is present.
  throw new Error("step-up credential missing after validation");
}

/**
 * GET /users/me/recovery-email
 * Settings-panel bootstrap: the caller's current recovery email + verification
 * state. Owner-only (id from the session, never the body).
 */
export async function getMyRecoveryEmail(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const statusResult = await recoveryEmailService.getRecoveryEmailStatus(req.user.id);
  if (!statusResult.success) {
    switch (statusResult.error.type) {
      case "USER_NOT_FOUND":
        res.status(404).json({
          status: "error",
          statusCode: 404,
          message: "Your account no longer exists.",
        });
        return;
      default: {
        const exhaustiveCheck: never = statusResult.error.type;
        throw new Error(`Unhandled recovery-email status error: ${String(exhaustiveCheck)}`);
      }
    }
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Recovery email retrieved successfully",
    data: statusResult.value,
  };
  res.status(200).json(response);
}

/**
 * POST /users/me/recovery-email/step-up-challenge
 * Mail a one-time step-up code to the caller's PRIMARY email. Required by
 * OAuth-only users (no password) before they can verify/clear the recovery email.
 */
export async function sendStepUpChallenge(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  await auth.api.sendVerificationOTP({ body: { email: req.user.email, type: "sign-in" } });

  const response: ApiResponse<{ ok: true }> = {
    status: "success",
    statusCode: 200,
    message: "A step-up verification code has been sent to your primary email.",
    data: { ok: true },
  };
  res.status(200).json(response);
}

/**
 * POST /users/me/recovery-email/start
 * Step 1 of setting/changing the recovery email: emails an ownership-proving code
 * to the NEW candidate address. Does not change the stored value yet.
 */
export async function startRecoveryEmail(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = StartRecoveryEmailSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, z.flattenError(parsedBody.error).fieldErrors);
    return;
  }

  const startResult = await recoveryEmailService.startRecoveryEmailChange(
    req.user.id,
    req.user.email,
    parsedBody.data.recoveryEmail,
  );

  if (!startResult.success) {
    switch (startResult.error.type) {
      case "SAME_AS_PRIMARY":
        res.status(409).json({
          status: "error",
          statusCode: 409,
          message: "Your recovery email must be different from your primary email.",
        });
        return;
      case "EMAIL_SEND_FAILED":
        res.status(502).json({
          status: "error",
          statusCode: 502,
          message: "Could not send the verification code. Please try again.",
        });
        return;
      default: {
        const exhaustiveCheck: never = startResult.error;
        throw new Error(`Unhandled recovery-email start error: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  }

  const response: ApiResponse<{ ok: true }> = {
    status: "success",
    statusCode: 202,
    message: "A verification code has been sent to that address.",
    data: { ok: true },
  };
  res.status(202).json(response);
}

/**
 * POST /users/me/recovery-email/verify
 * Step 2: step-up proof + the candidate-address code → store the recovery email
 * as verified. Returns the owner PublicUser (now carrying the recovery fields).
 */
export async function verifyRecoveryEmail(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = VerifyRecoveryEmailSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, z.flattenError(parsedBody.error).fieldErrors);
    return;
  }

  const confirmResult = await recoveryEmailService.confirmRecoveryEmailChange(
    req.user.id,
    req.user.email,
    parsedBody.data.otp,
    toStepUpCredential(parsedBody.data),
  );

  if (!confirmResult.success) {
    switch (confirmResult.error.type) {
      case "STEP_UP_INVALID":
        res.status(401).json({
          status: "error",
          statusCode: 401,
          message: "Step-up verification failed. Check your password or code.",
        });
        return;
      case "OTP_INVALID":
        res.status(401).json({
          status: "error",
          statusCode: 401,
          message: "Invalid or expired verification code.",
        });
        return;
      case "OTP_EXPIRED":
        res.status(410).json({
          status: "error",
          statusCode: 410,
          message: "That verification code has expired. Request a new one.",
        });
        return;
      case "TOO_MANY_ATTEMPTS":
        res.status(403).json({
          status: "error",
          statusCode: 403,
          message: "Too many incorrect attempts. Request a new code.",
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
        const exhaustiveCheck: never = confirmResult.error;
        throw new Error(
          `Unhandled recovery-email verify error: ${JSON.stringify(exhaustiveCheck)}`,
        );
      }
    }
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Recovery email verified and saved.",
    data: confirmResult.value,
  };
  res.status(200).json(response);
}

/**
 * DELETE /users/me/recovery-email
 * Remove the recovery email. Step-up gated like setting it.
 */
export async function deleteRecoveryEmail(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = ClearRecoveryEmailSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, z.flattenError(parsedBody.error).fieldErrors);
    return;
  }

  const clearResult = await recoveryEmailService.clearRecoveryEmail(
    req.user.id,
    req.user.email,
    toStepUpCredential(parsedBody.data),
  );

  if (!clearResult.success) {
    switch (clearResult.error.type) {
      case "STEP_UP_INVALID":
        res.status(401).json({
          status: "error",
          statusCode: 401,
          message: "Step-up verification failed. Check your password or code.",
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
        const exhaustiveCheck: never = clearResult.error;
        throw new Error(`Unhandled recovery-email clear error: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Recovery email removed.",
    data: clearResult.value,
  };
  res.status(200).json(response);
}
