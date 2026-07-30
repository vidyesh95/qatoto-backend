import type { Request, Response, NextFunction, RequestHandler } from "express";
import express from "express";

/**
 * JSON body parsers with per-route size caps, for routes the global 10 kb parser in
 * src/app.ts is too small for (R_AND_D_BACKEND_STRUCTURE.md §4a, blocker 4).
 *
 * MOUNT ORDER IS LOAD-BEARING. body-parser sets `req._body` once it has parsed, and
 * every later parser short-circuits on that flag. So a larger `json()` placed AFTER
 * the global one is a silent no-op — the 10 kb cap has already rejected the request.
 * These must mount ABOVE `app.use(express.json({ limit: "10kb" }))`.
 *
 * ⚠️ THE SAME RULE RUNS THE OTHER WAY, AND IT MEANS THESE PARSERS DO NOT CURRENTLY WORK
 * (§11l.4). "First parse wins" is symmetric: the global parser in `src/app.ts` is mounted
 * ahead of every router, so a `parseCompactJsonBody` INSIDE a router can never run — the
 * route's real cap is 10 kb, whatever its chain says. Where a prefix-level parser was
 * mounted above the global one, that prefix's routes got 128 kb instead, again regardless
 * of what the route asked for. Seventy-seven registrations name one of these two parsers
 * and not one of them is in effect.
 *
 * DO NOT "FIX" THIS BY DELETING THE PREFIX MOUNTS. That drops those routes to the global
 * 10 kb, which is BELOW what several schemas legitimately produce — the non-English 413
 * described below is exactly what the prefix mounts were added to prevent. A per-route cap
 * cannot work by stacking parsers at all; it needs one parse at the largest cap plus a
 * separate size check per route. §11l.4 has the shape and the measurements.
 *
 * Why the global cap is genuinely too small: `limit` counts BYTES while
 * `z.string().max(n)` counts UTF-16 code units. A 5,000-character project description
 * is ~5 KB in ASCII but up to 15 KB in UTF-8 for Devanagari or CJK — so the global cap
 * rejects payloads Zod would happily accept, FOR NON-ENGLISH USERS ONLY. That is a
 * bug that would never surface in English-language testing.
 *
 * Both parsers translate body-parser's 413 into our standard envelope with the cap
 * named, rather than letting Express's raw PayloadTooLargeError escape and bypass the
 * ApiResponse shape entirely (§4a calls this out by name).
 */
const COMPACT_BODY_LIMIT = "16kb";
const LONG_FORM_BODY_LIMIT = "128kb";

interface PayloadTooLargeCandidate {
  readonly status?: number;
  readonly type?: string;
}

/**
 * body-parser signals an over-cap body with `status: 413` and
 * `type: "entity.too.large"`. Read both defensively — this is an untyped third-party
 * error object, and CLAUDE.md bans blind type assertions.
 */
function isPayloadTooLarge(parseError: unknown): boolean {
  if (typeof parseError !== "object" || parseError === null) {
    return false;
  }
  const candidate: PayloadTooLargeCandidate = parseError;
  return candidate.status === 413 || candidate.type === "entity.too.large";
}

function createJsonBodyParser(limit: string, humanReadableLimit: string): RequestHandler {
  const parseJson = express.json({ limit });

  return function parseJsonBody(req: Request, res: Response, next: NextFunction): void {
    parseJson(req, res, (parseError: unknown) => {
      if (!parseError) {
        next();
        return;
      }

      if (isPayloadTooLarge(parseError)) {
        res.status(413).json({
          status: "error",
          statusCode: 413,
          message: `Request body exceeds the ${humanReadableLimit} size limit.`,
        });
        return;
      }

      next(parseError);
    });
  };
}

/** 16 kb — short bodies: notes, decisions, titles, single-field patches. */
export const parseCompactJsonBody = createJsonBodyParser(COMPACT_BODY_LIMIT, "16 KB");

/**
 * 128 kb — the idea wizard and project PATCH, which carry a description, a problem
 * statement, a solution summary and demand-evidence notes in one payload.
 */
export const parseLongFormJsonBody = createJsonBodyParser(LONG_FORM_BODY_LIMIT, "128 KB");
