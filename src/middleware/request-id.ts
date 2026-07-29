import { randomUUID } from "node:crypto";

import type { NextFunction, Request, Response } from "express";

/**
 * Correlates a request across the response header and every log line it produces
 * (R_AND_D_BACKEND_STRUCTURE.md §11l.2 item 6).
 *
 * WHAT CHANGED, and why it was a real gap rather than a tidy-up: this middleware minted an
 * id and set `X-Request-Id` on the response, and the id reached NOTHING else. Not `req`,
 * not morgan, not the error handler. A user quoting the id from a failed request handed
 * support a string that appeared in no log on any machine.
 *
 * `req.requestId` is now the correlation key, typed in `src/types/express.d.ts`.
 *
 * AN INBOUND HEADER IS STILL HONOURED — a proxy or a native client that already has a
 * trace id should keep it — but it is now BOUNDED and SANITIZED. It is echoed into a
 * response header and into log lines, so an unbounded client-supplied string is a log
 * injection vector and a header-size problem. Anything that is not a short, printable,
 * URL-safe token is replaced with a fresh UUID rather than rejected: a request should not
 * fail because a proxy sent an odd trace id.
 */

/** Long enough for a UUID or a W3C trace id, short enough not to bloat a header. */
const MAXIMUM_INBOUND_LENGTH = 128;
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]+$/;

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers["x-request-id"];
  const candidate = Array.isArray(header) ? header[0] : header;

  const id =
    typeof candidate === "string" &&
    candidate.length > 0 &&
    candidate.length <= MAXIMUM_INBOUND_LENGTH &&
    SAFE_REQUEST_ID.test(candidate)
      ? candidate
      : randomUUID();

  req.requestId = id;
  res.setHeader("X-Request-Id", id);
  next();
}
