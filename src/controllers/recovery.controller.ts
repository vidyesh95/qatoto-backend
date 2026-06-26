import type { Request, Response } from "express";
import { z } from "zod";

import * as recoveryService from "#src/services/recovery.service.js";
import type { ApiResponse } from "#src/types/index.js";

/** A recovery email, normalized to the stored canonical form before validation. */
const RecoveryEmailField = z
  .email("A valid email is required.")
  .transform((email) => email.trim().toLowerCase());

/** Body for POST /recovery/start. `.strict()` rejects unknown keys. */
const StartRecoverySchema = z.object({ recoveryEmail: RecoveryEmailField }).strict();

/** Body for POST /recovery/complete. */
const CompleteRecoverySchema = z
  .object({
    recoveryEmail: RecoveryEmailField,
    otp: z.string().min(1, "Verification code is required."),
    password: z.string().min(8, "Password must be at least 8 characters."),
  })
  .strict();

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

/**
 * POST /recovery/start — public.
 *
 * Emails a password-reset code to a VERIFIED recovery email, if one is on file.
 * Always returns the same generic 200 regardless of whether the address exists, so
 * it can't be used to probe which recovery emails are registered (anti-enumeration,
 * mirroring /signup/start).
 */
export async function startRecovery(req: Request, res: Response): Promise<void> {
  const parsedBody = StartRecoverySchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, z.flattenError(parsedBody.error).fieldErrors);
    return;
  }

  await recoveryService.sendRecoveryResetOtp(parsedBody.data.recoveryEmail);

  const response: ApiResponse<{ ok: true }> = {
    status: "success",
    statusCode: 200,
    message: "If that recovery email is on file, a reset code has been sent.",
    data: { ok: true },
  };
  res.status(200).json(response);
}

/**
 * POST /recovery/complete — public.
 *
 * Verifies the reset code mailed to the recovery email and sets a new password on
 * the primary account, then revokes all sessions. A wrong/expired code OR an
 * unknown recovery email both return the SAME generic 401 — never revealing which.
 * No session is minted: the user signs in fresh with the new password.
 */
export async function completeRecovery(req: Request, res: Response): Promise<void> {
  const parsedBody = CompleteRecoverySchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, z.flattenError(parsedBody.error).fieldErrors);
    return;
  }

  const { recoveryEmail, otp, password } = parsedBody.data;
  const resetResult = await recoveryService.resetPasswordViaRecovery(recoveryEmail, otp, password);

  if (!resetResult.success) {
    switch (resetResult.error.type) {
      case "INVALID":
        res.status(401).json({
          status: "error",
          statusCode: 401,
          message: "Invalid or expired verification code.",
        });
        return;
      default: {
        const exhaustiveCheck: never = resetResult.error.type;
        throw new Error(`Unhandled recovery reset error: ${String(exhaustiveCheck)}`);
      }
    }
  }

  const response: ApiResponse<{ ok: true }> = {
    status: "success",
    statusCode: 200,
    message: "Password reset. Please sign in with your new password.",
    data: { ok: true },
  };
  res.status(200).json(response);
}
