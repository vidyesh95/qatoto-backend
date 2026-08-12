import { createHash } from "node:crypto";

import { config } from "#src/config/index.js";

/**
 * The per-viewer, per-day ranking seed — HOME_BACKEND_STRUCTURE.md §4.3.
 *
 * ## What it is for
 *
 * §4.3 gives exploration 10 of the feed's 100 points, computed as
 * `hash(rankSeed, videoId) % 11`. The seed is minted server-side on a first request,
 * **echoed in every response, and accepted back on the next page request.**
 *
 * That round trip is the whole design. Rule 2 forbids `Math.random()`, and it would be
 * wrong here even if it did not: a random exploration term reshuffles the ranking between
 * page 1 and page 2, so a viewer scrolling sees some videos twice and never sees others at
 * all. A pinned seed makes the exploration deterministic for the length of a session while
 * still differing between viewers and between days.
 *
 * ## Why it is derived rather than random
 *
 * A random 32-hex string would work for the pinning, but it would have to be stored to
 * survive a viewer opening the feed twice in one day — and storing a per-visitor token is
 * a bigger commitment than this feature is worth. Deriving it from the secret plus the
 * viewer key plus the UTC day gives the same three properties for free: stable within a
 * day, different across days, different across viewers, and nothing persisted.
 *
 * Derived from `BETTER_AUTH_SECRET` for the reason `viewer-fingerprint.ts` and
 * `physical-receipts.service.ts` are: a deployment that forgot a dedicated env var would
 * silently fall back to an empty salt, and an unsalted seed is one an attacker can compute
 * — which would let them work out which videos land in which exploration bucket and
 * publish into the winning one.
 */

/** §5.1's query schema declares `rankSeed: z.string().length(32)`. */
export const RANK_SEED_LENGTH = 32;

export interface RankSeedInput {
  /**
   * The user id when signed in, the §3.2 viewer fingerprint when not.
   *
   * Not the raw IP: the fingerprint already branches on identity and already rotates
   * daily, so reusing it keeps one notion of "who this viewer is" on the platform.
   */
  readonly viewerKey: string;
  /** `YYYY-MM-DD`, UTC — from `utcDayStringOf` in viewer-fingerprint.ts. */
  readonly asOfDayString: string;
}

export function mintRankSeed(input: RankSeedInput): string {
  return createHash("sha256")
    .update(
      `${config.BETTER_AUTH_SECRET}:rankseed:${input.asOfDayString}:${input.viewerKey}`,
      "utf8",
    )
    .digest("hex")
    .slice(0, RANK_SEED_LENGTH);
}

/**
 * Whether a client-supplied seed is one we can safely interpolate into the ranking SQL.
 *
 * The Zod schema already bounds the length, but this is the value that reaches an
 * `md5(...)` call inside an `ORDER BY`, so it is checked again at the point of use. A seed
 * is never trusted for anything but its own bytes — it selects an exploration bucket and
 * carries no authority whatsoever, which is why an attacker choosing their own is harmless.
 */
export function isWellFormedRankSeed(candidate: string): boolean {
  return new RegExp(`^[0-9a-f]{${String(RANK_SEED_LENGTH)}}$`).test(candidate);
}
