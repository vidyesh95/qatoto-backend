import type { Request, Response, NextFunction } from "express";

import { config } from "#src/config/index.js";
import { errorFields, logger } from "#src/lib/logger.js";
import type { ApiResponse } from "#src/types/index.js";

interface HttpError extends Error {
  status?: number;
  statusCode?: number;
  /** `http-errors` sets this true for messages its author considers client-safe. */
  expose?: boolean;
}

const INTERNAL_MESSAGE = "Something went wrong on our side. Please try again.";

/**
 * The last resort. Everything a controller handles deliberately never reaches here — this
 * is for the unrecoverable (CLAUDE.md §3.3): a lost database connection, a bug.
 *
 * TWO CHANGES, and the first is a §0 problem rather than an ergonomic one (§11l.2 item 6).
 *
 * **A 5xx no longer echoes `err.message` to the client.** It used to, in every environment.
 * An unexpected throw from `pg` carries text like `relation "compensation_period" does not
 * exist`, and that went straight into the response body. Anything 500-and-above is now
 * replaced with a fixed sentence UNLESS `http-errors` marked it `expose` — which is
 * precisely what that flag means. A 4xx keeps its message, because a 4xx from `createError`
 * is written for the caller.
 *
 * **Both the response and the log line carry the request id.** Without both halves, a user
 * reporting "it failed at 14:02" hands support a string that appears nowhere.
 *
 * Must have 4 parameters for Express to recognize it as an error handler.
 */
export function errorHandler(
  err: HttpError,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const statusCode = err.status ?? err.statusCode ?? 500;
  const isServerFault = statusCode >= 500;

  logger.error("unhandled request error", {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl.split("?")[0],
    status: statusCode,
    ...errorFields(err),
  });

  const message = isServerFault && err.expose !== true ? INTERNAL_MESSAGE : err.message;

  res.status(statusCode).json({
    status: "error",
    statusCode,
    message: message || INTERNAL_MESSAGE,
    data: {
      // The one string a user can quote that support can search a log for.
      requestId: req.requestId,
      // Development-only, as it always has been.
      ...(config.NODE_ENV === "development" && err.stack !== undefined ? { stack: err.stack } : {}),
    },
  } satisfies ApiResponse);
}
