import type { Request, Response } from "express";

import { config } from "#src/config/index.js";
import {
  requestAccountDeletion,
  type RequestAccountDeletionError,
} from "#src/modules/auth/privacy/account-deletion.service.js";
import {
  readLatestDataExport,
  requestDataExport,
  type RequestDataExportError,
} from "#src/modules/auth/privacy/data-export.service.js";
import { respondUnauthenticated } from "#src/modules/rnd/projects/project-error-response.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * The data-subject rights that have endpoints (Privacy Part 3).
 *
 * ONE ROUTE FOR DELETION, NOT THREE. There is no cancel and no "read my request", because
 * signing in is what cancels (`databaseHooks.session.create.before`, `src/lib/auth.ts`) —
 * so an authenticated caller is never mid-deletion and endpoints for that state would be
 * untestable and would lie about a state the system cannot enter.
 *
 * NO REQUEST BODY, AND THEREFORE NO SCHEMA MODULE. The subject is the session and the
 * grace period is the server's; there is nothing a client could send that would not be a
 * value the server has to override anyway (CLAUDE.md §1.1). The type-to-confirm friction
 * lives in the panel, where friction belongs — it is a UX device, never a check.
 */

function respondAccountDeletionError(res: Response, error: RequestAccountDeletionError): void {
  switch (error.type) {
    case "USER_NOT_FOUND":
      // Reached when the row is gone or already anonymized. 404 rather than 410: the
      // caller holds a session for a user that does not exist, which is a state to end,
      // not to explain.
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "Account not found.",
      } satisfies ApiResponse);
      return;

    case "STAFF_ACCOUNT":
      /**
       * 403 AND A NAMED PERSON, not a generic refusal. A staff member who cannot close
       * their own account needs to know who can — otherwise the honest reading of this
       * response is "the button is broken".
       */
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message:
          "Staff accounts are closed by an operator, not from Settings. " +
          "Email support@qatoto.com and your platform role will be removed first.",
      } satisfies ApiResponse);
      return;

    case "REQUEST_ALREADY_ACTIVE":
      // 409, not 200-with-the-existing-row. The account IS deactivated either way, but a
      // success here would tell a second tab it started something it did not.
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "This account is already scheduled for deletion.",
      } satisfies ApiResponse);
      return;

    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled account deletion error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * `POST /users/me/deletion-request` — deactivates NOW and schedules the erasure.
 *
 * 200, NOT 202. A 202 would say "we have accepted this and will decide later", and that
 * is the shape of the mailto flow this replaced. What actually happened is complete and
 * synchronous: the account is deactivated and every session is gone by the time this
 * response is written. The 30-day scrub is a separate, scheduled consequence — not an
 * outstanding verdict on this request.
 */
export async function createDeletionRequest(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const requested = await requestAccountDeletion(req.user.id);

  if (!requested.success) {
    respondAccountDeletionError(res, requested.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message:
      "Your account is deactivated and you have been signed out everywhere. " +
      "Sign in again before the scheduled date to restore it.",
    data: requested.value,
  } satisfies ApiResponse);
}

function respondDataExportError(res: Response, error: RequestDataExportError): void {
  switch (error.type) {
    case "USER_NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "Account not found.",
      } satisfies ApiResponse);
      return;

    case "EXPORT_ALREADY_IN_FLIGHT":
      // 409 rather than 200-with-the-existing-row: the caller asked to START one, and one
      // is already running. The GET below is where they find out how it is going.
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "An export is already being prepared. Check back in a moment.",
      } satisfies ApiResponse);
      return;

    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled data export error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * `POST /users/me/export` — **202**, a receipt, and a job in flight. Never a file.
 *
 * THE 202 IS THE HONEST STATUS and the frontend cannot see it. `readEnvelope` in the
 * client transport treats any 2xx as success and discards `statusCode`, so the panel must
 * learn "not ready yet" from the `state` field in this body — which is why the row is
 * returned rather than a bare acknowledgement.
 */
export async function createDataExport(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  /**
   * GATED AT THE DOOR, unlike the anonymization flag which gates the JOB.
   *
   * A dry-run anonymization is useful — it reports what it would erase and writes nothing.
   * A dry-run export is just broken: it would accept the request, poll forever and never
   * produce a file. 503 is a state the panel can render honestly.
   */
  if (!config.DATA_EXPORT_ENABLED) {
    res.status(503).json({
      status: "error",
      statusCode: 503,
      message:
        "Downloads are not switched on yet. Email support@qatoto.com and we will send " +
        "your data within one month.",
    } satisfies ApiResponse);
    return;
  }

  const requested = await requestDataExport(req.user.id);

  if (!requested.success) {
    respondDataExportError(res, requested.error);
    return;
  }

  res.status(202).json({
    status: "success",
    statusCode: 202,
    message: "We are building your file. It can take a few minutes.",
    data: requested.value,
  } satisfies ApiResponse);
}

/**
 * `GET /users/me/export` — the state, and a five-minute link once there is one.
 *
 * 200 WITH `data: null` WHEN THERE IS NO EXPORT, never a 404. "You have never asked for
 * one" is an answer, and forcing the client to translate an error into an absence is how
 * a fetch failure ends up rendering as "no export" (CLAUDE.md Pattern 3).
 */
export async function getDataExport(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const latest = await readLatestDataExport(req.user.id);

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: latest === null ? "No export has been requested." : "Export status loaded.",
    data: latest,
  } satisfies ApiResponse);
}
