import { createHash } from "node:crypto";

import { config } from "#src/config/index.js";

/**
 * Identifying a viewer for one UTC day without storing who they are —
 * HOME_BACKEND_STRUCTURE.md §3.2.
 *
 * WHAT THIS IS FOR. `video_view_session` is unique on
 * `(video_id, viewer_fingerprint, view_day_bucket)`, and that index is the anti-replay
 * boundary for the beacon: without a stable per-viewer key, a headless loop opens a
 * fresh session per request and the clamp in `view-beacon-clamp.ts` becomes decorative,
 * because it bounds what ONE session can claim, not how many sessions exist.
 *
 * It is NOT an identity. It is a per-day bucket key with two jobs: making that unique
 * index meaningful for logged-out viewers, and giving an anonymous visitor a
 * session-scoped topic affinity (§4.4) so their feed responds to what they watch.
 * Rows carrying it are deleted at 90 days.
 *
 * THE RAW IP IS NEVER WRITTEN TO THE DATABASE. It appears here, inside a hash, and
 * nowhere else.
 *
 * ## Why this branches on identity, when §3.2 does not
 *
 * §3.2 specifies `sha256(salt || clientIp || userAgent)` unconditionally. That formula
 * is wrong for signed-in viewers, and the failure is silent:
 *
 *   Two signed-in users in one office, on the same browser build, hash to the SAME
 *   fingerprint. The unique index then collapses them into ONE `video_view_session`
 *   row. Whoever arrives first owns the row and its `viewer_id`, and the second
 *   person's watch time is attributed to the first — feeding
 *   `completion_bp_sum`, the component carrying 40 of ranking's 100 points.
 *
 * That is a correctness bug in the ranker's most important input, not a privacy
 * nicety. Branching on identity removes it entirely for the population whose sessions
 * actually rank, and preserves every property §3.2 was protecting: the salt still
 * rotates daily, it is still not persisted next to the hash, and the raw IP is still
 * never stored. It also makes a signed-in viewer's bucket independent of which network
 * they happened to watch from, which is the behaviour a user would expect anyway.
 *
 * ## Why the salt is derived rather than configured
 *
 * §3.2 asks for a "daily rotating salt". Deriving it from `BETTER_AUTH_SECRET` plus the
 * UTC day string rotates it by construction — no table, no minting race, no prune job.
 * A dedicated env var would be worse: a deployment that forgot to set one would fall
 * back to an empty salt, and an unsalted hash of an IP is a rainbow-table lookup away
 * from being the IP. This is the same call `physical-receipts.service.ts` makes for
 * its device fingerprint, for the same reason.
 *
 * Yesterday's hashes stay recomputable by anyone holding the secret. That is
 * acceptable: the secret is already the key to every session on the platform, and the
 * rows are dropped at 90 days regardless.
 */
export interface ViewerFingerprintInput {
  /**
   * `YYYY-MM-DD`, UTC. The caller writes this SAME string to the row's day-bucket
   * column — the fingerprint and the bucket must agree, or a beacon that crosses
   * midnight between the two derivations lands in a bucket its hash does not match
   * and silently starts a second session.
   */
  readonly utcDayString: string;
  /** NULL for an anonymous viewer. Its presence is what selects the branch. */
  readonly viewerUserId: string | null;
  /** From `req.ip` only. Never a hand-parsed `x-forwarded-for`. */
  readonly clientIp: string;
  readonly userAgent: string;
}

/**
 * The domain separators are not decoration. Without them a crafted user id of
 * `"1.2.3.4:Mozilla/5.0"` would hash identically to an anonymous viewer at that
 * address, which is a way to write to someone else's session row.
 */
function computeFingerprintForDomain(domain: string, input: ViewerFingerprintInput): string {
  const identityComponent =
    input.viewerUserId !== null
      ? `u:${input.viewerUserId}`
      : `a:${input.clientIp}:${input.userAgent}`;

  return createHash("sha256")
    .update(
      `${config.BETTER_AUTH_SECRET}:${domain}:${input.utcDayString}:${identityComponent}`,
      "utf8",
    )
    .digest("hex");
}

/** The video feed's per-day viewer key — `video_view_session.viewer_fingerprint`. */
export function computeViewerFingerprint(input: ViewerFingerprintInput): string {
  return computeFingerprintForDomain("videoview", input);
}

/**
 * The store's per-day viewer key — `commerce_product_view_session.viewer_fingerprint`
 * (STORE Phase 13).
 *
 * A SEPARATE DOMAIN SEPARATOR, and the separation is the whole reason this function
 * exists rather than callers passing a string. Sharing `videoview` would give one person
 * the same fingerprint in both tables, so two unique indexes built for unrelated purposes
 * would key off one value — and anyone who learned a fingerprint from one surface could
 * address the other surface's row for that viewer.
 */
export function computeCommerceViewerFingerprint(input: ViewerFingerprintInput): string {
  return computeFingerprintForDomain("commerceview", input);
}

/**
 * The UTC day, as the string that goes into both the hash above and the row's
 * day-bucket column.
 *
 * MOVED TO `utc-day.ts` and re-exported here. This module reads `config` at module scope,
 * so anything importing the day helper from here transitively required a fully populated
 * environment — harmless in a running process, fatal in a unit test that only wanted to
 * name a day. Existing imports are unaffected.
 */
export { utcDayStringOf } from "#src/lib/utc-day.js";
