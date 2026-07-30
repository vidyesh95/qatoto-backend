import type { NextFunction, Request, RequestHandler, Response } from "express";
import express from "express";

import type { ApiResponse } from "#src/types/index.js";

/**
 * ONE JSON parse at the ceiling, then a per-route size check
 * (R_AND_D_BACKEND_STRUCTURE.md §11l.4).
 *
 * WHY IT IS SHAPED THIS WAY, and not as two parsers. body-parser sets `req._body` on the
 * first successful parse and every later parser short-circuits on that flag, so THE FIRST
 * PARSE WINS — always, by design. The previous arrangement had a per-route
 * `parseCompactJsonBody` (16 kb) inside routers and a global `express.json({ limit: "10kb" })`
 * mounted ahead of every one of them, plus a 128 kb parser on three prefixes above that. The
 * result: none of the 77 per-route registrations ever ran. A route's real cap was 10 kb, or
 * 128 kb behind a prefix, whatever its own chain said.
 *
 * That was not merely untidy. `PUT /playlists/:id/videos` accepts 500 ids of 64 characters —
 * about 33 kb of pure ASCII — against a 10 kb cap, so it failed for everyone. Products,
 * series, playlists, suppliers and `PATCH /milestones/:id` failed for anyone writing
 * Devanagari or CJK, because `limit` counts BYTES while `z.string().max(n)` counts UTF-16
 * code units. That is the same class of bug the prefix mounts were added to fix, still live
 * on every route they did not happen to cover.
 *
 * DELETING THE PREFIX MOUNTS IS NOT THE FIX — it drops those routes to the global 10 kb,
 * which is below what several schemas legitimately produce. It was tried and reverted. A
 * per-route cap cannot work by stacking parsers at all; it has to stop being a parser.
 *
 * SO: parse once, at the largest cap any route needs, and record the raw byte length. Each
 * route then enforces its own cap as an ordinary middleware check against that number. Two
 * facts in body-parser 2.3.0 make this sound, both in `lib/read.js`:
 *
 *   * `verify` is called only from `getBody`'s SUCCESS branch. A body over `limit` returns
 *     before it, so the ceiling still rejects without any of this code running.
 *   * `opts.encoding = verify ? null : encoding` — supplying `verify` puts raw-body in Buffer
 *     mode and body-parser decodes afterwards itself. `buf.length` is therefore the true BYTE
 *     count, which is exactly what a cap denominated in bytes must compare against.
 *
 * WHAT THE CEILING COSTS. A 100 kb body aimed at a 16 kb route is now buffered before being
 * rejected, where a root-mounted route used to stop at 10 kb. 128 kb is small, and the six
 * routers behind the old prefix mounts already buffered that much.
 */

/**
 * The ceiling, and the largest cap any route may ask for. Sized for the long-form R&D
 * payloads: a description, problem statement, solution summary and evidence notes in one
 * body, where a 5,000-character field is ~5 kb in ASCII and up to 15 kb in UTF-8.
 */
export const MAX_JSON_BODY_BYTES = 128 * 1024;

/** Short bodies: notes, decisions, titles, single-field patches. */
export const COMPACT_JSON_BODY_BYTES = 16 * 1024;

interface PayloadTooLargeCandidate {
  readonly status?: number;
  readonly type?: string;
}

/**
 * body-parser signals an over-cap body with `status: 413` and `type: "entity.too.large"`.
 * Read both defensively — this is an untyped third-party error object, and CLAUDE.md bans
 * blind type assertions.
 */
function isPayloadTooLarge(parseError: unknown): boolean {
  if (typeof parseError !== "object" || parseError === null) {
    return false;
  }
  const candidate: PayloadTooLargeCandidate = parseError;
  return candidate.status === 413 || candidate.type === "entity.too.large";
}

function respondPayloadTooLarge(res: Response, humanReadableLimit: string): void {
  const response: ApiResponse = {
    status: "error",
    statusCode: 413,
    message: `Request body exceeds the ${humanReadableLimit} size limit.`,
  };
  res.status(413).json(response);
}

/**
 * The caps every `limitBodyBytes` handler was built with, by handler reference.
 *
 * Exists for `json-body-budget.test.ts`, which sweeps every mounted route and has to answer
 * "what cap does this route actually carry?". Reference identity is the only way to ask:
 * both tiers are closures produced by the same factory, so `.name` cannot tell them apart.
 */
const capsByHandler = new Map<unknown, number>();

/** The cap a handler enforces, or undefined if it is not one of ours. */
export function bodyLimitOf(handler: unknown): number | undefined {
  return capsByHandler.get(handler);
}

/**
 * A per-route body cap, checked against the byte length `parseJsonBodyOnce` recorded.
 *
 * `req.rawBodyBytes` is UNDEFINED rather than zero when no JSON body was parsed — a bodiless
 * GET, a content-type this parser does not claim, or a multipart upload multer owns
 * (`read.js` returns before `verify` in all three cases). Those must pass through untouched,
 * so undefined is "nothing to check", never "a body of size zero".
 */
export function limitBodyBytes(maxBytes: number, humanReadableLimit: string): RequestHandler {
  if (maxBytes > MAX_JSON_BODY_BYTES) {
    // A cap above the ceiling is unreachable and would read as a promise the parser cannot
    // keep. Fail at module load rather than at the first oversized request.
    throw new Error(
      `Body cap ${String(maxBytes)}B exceeds the parser ceiling ${String(MAX_JSON_BODY_BYTES)}B.`,
    );
  }

  const handler: RequestHandler = function enforceBodyLimit(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const bytes = req.rawBodyBytes;
    if (bytes !== undefined && bytes > maxBytes) {
      respondPayloadTooLarge(res, humanReadableLimit);
      return;
    }
    next();
  };

  capsByHandler.set(handler, maxBytes);
  return handler;
}

/**
 * The one JSON parser, mounted globally in `src/app.ts`.
 *
 * Records the raw byte length for `limitBodyBytes` to read, and translates body-parser's own
 * 413 into the project envelope with the ceiling named. Without that translation the caller
 * gets body-parser's untranslated `"request entity too large"`, which never says what the
 * limit was.
 */
export const parseJsonBodyOnce: RequestHandler = (() => {
  const parseJson = express.json({
    limit: MAX_JSON_BODY_BYTES,
    verify: (req, _res, buf) => {
      // `req` is typed `http.IncomingMessage` here, not `express.Request` — the property is
      // declared on the Express interface, which this object becomes by the time any route
      // middleware reads it.
      Reflect.set(req, "rawBodyBytes", buf.length);
    },
  });

  return function parseJsonBody(req: Request, res: Response, next: NextFunction): void {
    parseJson(req, res, (parseError: unknown) => {
      if (!parseError) {
        next();
        return;
      }

      if (isPayloadTooLarge(parseError)) {
        respondPayloadTooLarge(res, "128 KB");
        return;
      }

      next(parseError);
    });
  };
})();

/** 16 KB. Shared instance — a cap check holds no per-route state. */
export const compactBody = limitBodyBytes(COMPACT_JSON_BODY_BYTES, "16 KB");

/** 128 KB, the ceiling. Declared explicitly so a route states its cap rather than inheriting. */
export const longFormBody = limitBodyBytes(MAX_JSON_BODY_BYTES, "128 KB");
