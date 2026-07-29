import type { NextFunction, Request, Response } from "express";

import { logger } from "#src/lib/logger.js";

/**
 * One structured line per completed request (§11l.2 item 6).
 *
 * REPLACES `morgan("dev")`, and the reason is not aesthetics. morgan's format string has no
 * access to values set on `req`, so it could never carry `req.requestId` — which meant the
 * id this app returns to every client appeared in no log line anywhere. A user quoting it
 * gave support a string to search for and nothing to find.
 *
 * Logged on `finish`, not on entry: a line written before the handler runs cannot carry a
 * status or a duration, and two lines per request to get both is twice the volume for the
 * same fact.
 *
 * WHAT IS DELIBERATELY NOT LOGGED: the request body, the query string, and any header. A
 * body here would put pledge amounts, compensation rates and OAuth state into a log stream
 * (§7A.6, §9.10) — the same reasoning that keeps amounts out of a notification payload.
 * The path is logged; `req.originalUrl` includes the query string, so it is stripped.
 */
export function requestLog(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMilliseconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const [path] = req.originalUrl.split("?");

    // 5xx is the server's fault and belongs at `error`; 4xx is a caller's and is `warn`, so
    // an alert on `error` is not drowned by every 404 a crawler produces.
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";

    logger[level]("request", {
      requestId: req.requestId,
      method: req.method,
      path: path ?? req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(durationMilliseconds * 100) / 100,
      // The caller, when there is one. An id, never an email — a log is not a place to
      // accumulate personal data (§9.10).
      userId: req.user?.id,
    });
  });

  next();
}
