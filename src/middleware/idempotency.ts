import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

import { db } from "#src/db/index.js";
import { idempotencyRecord } from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * `Idempotency-Key` (R_AND_D_BACKEND_STRUCTURE.md §11l.2 item 3).
 *
 * WHAT THIS IS FOR. A retried POST on a flaky mobile connection must not record two
 * pledges, finalize a statement twice, or open two disputes. Four surfaces already solve
 * this with a body-carried key and a unique index — and that shape is right where the key
 * belongs to the domain row. It does not generalize to a verb with nowhere to put one.
 *
 * HONOUR-IF-PRESENT, NOT REQUIRE. A caller that sends no key gets exactly today's
 * behaviour. That is deliberate and it is the only safe default: the shipped frontend
 * already mints keys but does not send them on every route, and a middleware that started
 * refusing keyless requests would break writes that work today. `{ required: true }` is
 * there for when a route is ready to insist.
 *
 * THE FINGERPRINT IS THE POINT. A key alone answers "have I seen this key?"; the
 * fingerprint answers "was it this request?". Without it, a client that recycles one key
 * across two different pledges receives the first pledge's receipt for the second and
 * believes both landed. A mismatch is `409`, never a silent replay.
 *
 * ONLY 2xx IS RECORDED. A retry after a transient 500 must actually retry; caching the
 * failure would make the error permanent for that key.
 *
 * WHAT IT DOES NOT DO: it does not make a handler atomic. The stored response is written
 * AFTER the handler answered, so two concurrent requests with the same key can both pass
 * the pre-check and both execute. The domain-level guards — the unique indexes, the
 * conditional `WHERE status = 'proposed'` updates, the `FOR UPDATE` locks — remain the
 * authority for that, exactly as they were. This closes the RETRY window, which is the one
 * a person on a train actually hits.
 */

const IDEMPOTENCY_HEADER = "idempotency-key";
const MINIMUM_KEY_LENGTH = 8;
const MAXIMUM_KEY_LENGTH = 200;

export interface IdempotencyOptions {
  /** When true, a request with no `Idempotency-Key` is refused with `400`. */
  readonly required?: boolean;
  /**
   * Defaults to the historical user scope. Commerce routes may opt into the
   * organization scope only after active membership/trade context was proven.
   */
  readonly scope?: "user" | "active_organization";
}

/**
 * The organization this request is acting for, whichever guard proved it.
 *
 * Phase 21 introduced a second proven context: `requireProvisionedBuyerCommerceWorkspace`
 * attaches `buyerCommerceWorkspace`, which may be a `pending` shell (§14, A37). Both
 * contexts are re-proven from memberships on every request, so both are equally valid as an
 * idempotency scope — the scope's job is to keep one organization's replay from colliding
 * with another's, and it does not care whether that organization may yet trade.
 *
 * Reading only `commerceOrganization` here would 403 every swapped route the moment it
 * carried an `Idempotency-Key`, which is most of the cart.
 */
function scopedOrganizationId(req: Request): string | null {
  return (
    req.commerceOrganization?.organizationId ?? req.buyerCommerceWorkspace?.organizationId ?? null
  );
}

/**
 * SHA-256 over the canonicalized body plus the path.
 *
 * `JSON.stringify` with sorted keys rather than `canonicalizeDocument`: this hashes an
 * arbitrary request body, which may legitimately contain the plain numbers and nested
 * shapes that the audit canonicalizer refuses by design. A different serialization is
 * acceptable here because the value never leaves this table — nothing chains off it.
 */
function fingerprintRequest(req: Request): string {
  const body: unknown = req.body;
  const requestHash = createHash("sha256").update(
    `${req.method}\n${req.originalUrl}\n${stableStringify(body)}`,
  );
  if (req.file) {
    // Multipart evidence retries must identify the bytes, not only the text fields.
    // Otherwise one key reused with a different file would replay the first document.
    requestHash
      .update(
        `\n${req.file.fieldname}\n${req.file.originalname}\n${req.file.mimetype}\n${String(req.file.size)}\n`,
      )
      .update(req.file.buffer);
  }
  return requestHash.digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  // `Object.entries` over an `object` already yields `[string, unknown][]`; going through
  // a `Record` assertion would be a claim about a shape this function is deliberately
  // agnostic about.
  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);

  return `{${entries.join(",")}}`;
}

export function idempotency(options: IdempotencyOptions = {}) {
  return async function idempotencyMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const rawHeader = req.headers[IDEMPOTENCY_HEADER];
    const idempotencyKey = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    if (idempotencyKey === undefined || idempotencyKey === "") {
      if (options.required === true) {
        res.status(400).json({
          status: "error",
          statusCode: 400,
          message: "This request requires an Idempotency-Key header.",
        } satisfies ApiResponse);
        return;
      }
      next();
      return;
    }

    if (idempotencyKey.length < MINIMUM_KEY_LENGTH || idempotencyKey.length > MAXIMUM_KEY_LENGTH) {
      res.status(400).json({
        status: "error",
        statusCode: 400,
        message: `Idempotency-Key must be between ${String(MINIMUM_KEY_LENGTH)} and ${String(MAXIMUM_KEY_LENGTH)} characters.`,
      } satisfies ApiResponse);
      return;
    }

    // Runs AFTER `requireAuth`, always — the record is scoped to the caller, and a
    // keyless-but-authenticated user id is the whole scoping mechanism.
    if (!req.user) {
      next();
      return;
    }

    const userId = req.user.id;
    const scopeOrganizationId = scopedOrganizationId(req);
    if (options.scope === "active_organization" && scopeOrganizationId === null) {
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "An active commerce organization membership is required.",
      } satisfies ApiResponse);
      return;
    }

    const persistedIdempotencyKey =
      options.scope === "active_organization" && scopeOrganizationId !== null
        ? organizationScopedIdempotencyKey(scopeOrganizationId, idempotencyKey)
        : idempotencyKey;
    const requestFingerprint = fingerprintRequest(req);

    const [existing] = await db
      .select({
        requestFingerprint: idempotencyRecord.requestFingerprint,
        responseStatus: idempotencyRecord.responseStatus,
        responseBody: idempotencyRecord.responseBody,
      })
      .from(idempotencyRecord)
      .where(
        and(
          eq(idempotencyRecord.userId, userId),
          eq(idempotencyRecord.idempotencyKey, persistedIdempotencyKey),
        ),
      )
      .limit(1);

    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        res.status(409).json({
          status: "error",
          statusCode: 409,
          message: "This Idempotency-Key was already used for a different request.",
        } satisfies ApiResponse);
        return;
      }

      // The ORIGINAL response, replayed verbatim. `Idempotency-Replayed` says so, because
      // a client that cannot tell a replay from a fresh write cannot report accurately.
      res.setHeader("Idempotency-Replayed", "true");
      res.status(existing.responseStatus).type("application/json").send(existing.responseBody);
      return;
    }

    captureResponse(req, res, userId, persistedIdempotencyKey, requestFingerprint);
    next();
  };
}

function organizationScopedIdempotencyKey(
  organizationId: string,
  clientIdempotencyKey: string,
): string {
  const scopedDigest = createHash("sha256")
    .update(`${organizationId}\n${clientIdempotencyKey}`, "utf8")
    .digest("hex");
  return `org:${scopedDigest}`;
}

/**
 * Wraps `res.json` so a successful response is recorded on its way out.
 *
 * The write is fire-and-forget with a swallowed unique violation: two concurrent first
 * attempts both pass the pre-check, both run, and the loser's insert conflicts. Failing
 * the request at that point would turn a redundant success into an error for a caller who
 * did nothing wrong — and the response is already on the wire.
 */
function captureResponse(
  req: Request,
  res: Response,
  userId: string,
  idempotencyKey: string,
  requestFingerprint: string,
): void {
  const originalJson = res.json.bind(res);

  res.json = (body: unknown): Response => {
    const responseStatus = res.statusCode;

    if (responseStatus >= 200 && responseStatus <= 299) {
      void db
        .insert(idempotencyRecord)
        .values({
          userId,
          idempotencyKey,
          requestMethod: req.method,
          requestPath: req.originalUrl,
          requestFingerprint,
          responseStatus,
          responseBody: JSON.stringify(body),
        })
        .catch((error: unknown) => {
          if (isUniqueViolation(error)) return;
          // Not rethrown: the response has already been sent, and an unhandled rejection
          // here would take the process down over a cache write.
          console.error("[idempotency] could not record a response", {
            userId,
            path: req.originalUrl,
            error,
          });
        });
    }

    return originalJson(body);
  };
}
