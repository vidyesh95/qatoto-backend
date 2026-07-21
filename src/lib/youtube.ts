import type { Result } from "#src/types/index.js";

/**
 * YouTube link handling for the Creator Studio upload flow
 * (STUDIO_BACKEND_STRUCTURE.md §0, §3, §9).
 *
 * WHY THIS FILE IS A CHARACTER-FOR-CHARACTER MIRROR OF THE FRONTEND'S src/lib/youtube.ts.
 * The creator's URL is validated live in the browser and again here. If the two parsers
 * disagree by even one accepted shape, the creator gets a green checkmark followed by a
 * 422 — §3 names that exact failure as the reason the mirror requirement exists. The
 * hostname allowlist, the four path prefixes, the bare-11-char-id fast path, the
 * schemeless `https://` prepend and the `?v=` precedence are therefore all copied, not
 * re-derived. Change one side only by changing both.
 *
 * WHY PARSING IS A SECURITY BOUNDARY AND NOT A CONVENIENCE (§0). Everything downstream
 * handles an 11-character id, never the client's string. That is what makes the outbound
 * oEmbed URL safe to construct and what stops `javascript:` payloads, open redirects and
 * lookalike hosts (`youtube.com.evil.tld`) from ever reaching an `<iframe src>` or an
 * `href`. The stored value is the id; every embed URL the system emits is rebuilt here.
 *
 * WHY THIS MODULE IMPORTS NO CONFIG. The timeout arrives as an argument from the service,
 * so the whole module is a pure function of its inputs and its test suite needs neither
 * env stubs nor a network. Appendix A (self-hosted video) is DEFERRED and nothing here
 * knows about it.
 */

const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTNAMES = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

const YOUTUBE_SHORT_HOSTNAMES = new Set(["youtu.be", "www.youtu.be"]);

/** Path prefixes that carry the id as the segment right after them. */
const YOUTUBE_PATH_PREFIXES = ["/embed/", "/shorts/", "/live/", "/v/"];

/**
 * Hosts YouTube serves oEmbed thumbnails from. The payload is a third-party string that
 * we persist and the client renders in an `<img src>`, so it gets the same treatment as a
 * client string: allowlist the host or store nothing (§0).
 */
const YOUTUBE_THUMBNAIL_HOSTNAME_SUFFIXES = [".ytimg.com", ".youtube.com"];
const YOUTUBE_THUMBNAIL_HOSTNAMES = new Set(["ytimg.com", "youtube.com"]);

/** oEmbed titles are only ever offered as a prefill suggestion; bound them anyway. */
const MAX_SUGGESTED_TITLE_LENGTH = 200;

/**
 * Returns the 11-character video id, or null when the input is not a YouTube video link
 * this system can embed.
 */
export function extractYoutubeVideoId(rawUrl: string): string | null {
  const trimmedUrl = rawUrl.trim();
  if (trimmedUrl === "") return null;

  // Accept bare ids and schemeless links alike — both are shapes the frontend accepts,
  // and both are why the create schema must NOT wrap this in a `z.url()` (§7).
  if (YOUTUBE_VIDEO_ID_PATTERN.test(trimmedUrl)) return trimmedUrl;

  const urlWithScheme = /^https?:\/\//i.test(trimmedUrl) ? trimmedUrl : `https://${trimmedUrl}`;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlWithScheme);
  } catch {
    return null;
  }

  const hostname = parsedUrl.hostname.toLowerCase();

  if (YOUTUBE_SHORT_HOSTNAMES.has(hostname)) {
    return toVideoId(parsedUrl.pathname.slice(1));
  }

  // Exact-match set, never a suffix test: `youtube.com.evil.tld` and
  // `evil.tld/youtube.com/...` must both fall through to null.
  if (!YOUTUBE_HOSTNAMES.has(hostname)) return null;

  const watchVideoId = parsedUrl.searchParams.get("v");
  if (watchVideoId) return toVideoId(watchVideoId);

  const matchingPrefix = YOUTUBE_PATH_PREFIXES.find((pathPrefix) =>
    parsedUrl.pathname.startsWith(pathPrefix),
  );
  if (matchingPrefix) {
    return toVideoId(parsedUrl.pathname.slice(matchingPrefix.length));
  }

  return null;
}

/**
 * Shape check only. A perfectly-formed link to a deleted video passes this and fails at
 * the oEmbed step (§7) — both layers are needed, do not collapse them.
 */
export function isYoutubeVideoUrl(rawUrl: string): boolean {
  return extractYoutubeVideoId(rawUrl) !== null;
}

/**
 * The ONLY way an embed URL enters the system. Built from the stored id, never from a
 * client string (§0). `-nocookie` keeps YouTube from setting tracking cookies until the
 * viewer actually plays.
 */
export function buildYoutubeEmbedUrl(youtubeVideoId: string): string {
  return `https://www.youtube-nocookie.com/embed/${youtubeVideoId}`;
}

function toVideoId(pathSegment: string): string | null {
  const firstSegment = pathSegment.split("/")[0] ?? "";
  return YOUTUBE_VIDEO_ID_PATTERN.test(firstSegment) ? firstSegment : null;
}

/**
 * Accepts a provider thumbnail URL, or returns null so the row stores nothing rather than
 * a string the client would render. https only, host allowlisted.
 */
export function sanitizeYoutubeThumbnailUrl(rawThumbnailUrl: string): string | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawThumbnailUrl);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== "https:") return null;

  const hostname = parsedUrl.hostname.toLowerCase();
  const isAllowedHost =
    YOUTUBE_THUMBNAIL_HOSTNAMES.has(hostname) ||
    YOUTUBE_THUMBNAIL_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix));

  return isAllowedHost ? parsedUrl.toString() : null;
}

/**
 * The three ways a YouTube source can fail.
 *
 * The split between UNAVAILABLE (422) and VERIFY_FAILED (502) is deliberate and
 * load-bearing: the first means the creator gave us a bad link and must fix it, the
 * second means YouTube did not answer and retrying may work. Collapsing them into one
 * status would tell a creator to fix a link that was fine (§8).
 */
export type YoutubeSourceError =
  | { type: "INVALID_YOUTUBE_URL" }
  | { type: "YOUTUBE_VIDEO_UNAVAILABLE"; youtubeVideoId: string }
  | { type: "YOUTUBE_VERIFY_FAILED" };

/** What oEmbed tells us that is worth keeping. Both are offered, neither is authoritative. */
export interface YoutubeVideoFacts {
  /** Returned as `suggestedTitle`; NEVER written over a title the creator supplied (§9). */
  readonly suggestedTitle: string | null;
  /** Already host-allowlisted. Null when YouTube sent something we will not render. */
  readonly thumbnailUrl: string | null;
}

export type FetchImplementation = typeof globalThis.fetch;

export interface VerifyYoutubeVideoOptions {
  /** Bounds the call so a hanging request cannot hold an Express worker (§9). */
  readonly timeoutMs?: number;
  /** Injectable so the suite exercises every outcome with no network. */
  readonly fetchImplementation?: FetchImplementation;
}

const DEFAULT_OEMBED_TIMEOUT_MS = 3_000;

/**
 * How long a verified outcome is trusted before YouTube is asked again.
 *
 * Short, because the whole point of verifying is to notice a video that has been deleted
 * or made private. Long enough that a client retrying a 502, or a creator re-submitting
 * the modal, does not produce a second outbound request (§5).
 */
const OEMBED_CACHE_TTL_MS = 60_000;

/** Bounds the cache so a stream of distinct ids cannot grow it without limit. */
const OEMBED_CACHE_MAX_ENTRIES = 500;

/**
 * Negative outcomes are cached too, for the same reason `geocode_cache` stores misses
 * (schema.ts): re-asking a provider that already said "no such video" burns the budget on
 * a call that always fails. VERIFY_FAILED is deliberately NOT cached — it is transient,
 * and caching it would keep a healthy video rejected after YouTube recovered.
 */
type CachedOutcome =
  | { readonly kind: "verified"; readonly facts: YoutubeVideoFacts }
  | { readonly kind: "unavailable" };

interface CacheEntry {
  readonly outcome: CachedOutcome;
  readonly expiresAtEpochMs: number;
}

const oembedOutcomeCache = new Map<string, CacheEntry>();

function readCachedOutcome(youtubeVideoId: string, nowEpochMs: number): CachedOutcome | null {
  const entry = oembedOutcomeCache.get(youtubeVideoId);
  if (!entry) return null;

  if (entry.expiresAtEpochMs <= nowEpochMs) {
    oembedOutcomeCache.delete(youtubeVideoId);
    return null;
  }

  return entry.outcome;
}

function writeCachedOutcome(
  youtubeVideoId: string,
  outcome: CachedOutcome,
  nowEpochMs: number,
): void {
  // Evict the oldest insertion when full. Map preserves insertion order, so the first key
  // is the oldest — enough for a bound this small, and it needs no extra bookkeeping.
  if (oembedOutcomeCache.size >= OEMBED_CACHE_MAX_ENTRIES) {
    const oldestKey = oembedOutcomeCache.keys().next().value;
    if (oldestKey !== undefined) oembedOutcomeCache.delete(oldestKey);
  }

  oembedOutcomeCache.set(youtubeVideoId, {
    outcome,
    expiresAtEpochMs: nowEpochMs + OEMBED_CACHE_TTL_MS,
  });
}

/** Exposed for tests, which must not leak a cached outcome into the next case. */
export function clearYoutubeVerificationCache(): void {
  oembedOutcomeCache.clear();
}

interface YoutubeOembedPayload {
  readonly title?: string;
  readonly thumbnail_url?: string;
}

/**
 * A type guard rather than an `as` cast (CLAUDE.md §4). Both fields are optional because
 * neither is required for the verification itself to succeed — a 200 already proves the
 * video exists, is public and permits embedding.
 */
function isYoutubeOembedPayload(candidate: unknown): candidate is YoutubeOembedPayload {
  if (typeof candidate !== "object" || candidate === null) return false;
  const record: Record<string, unknown> = { ...candidate };
  return (
    (record.title === undefined || typeof record.title === "string") &&
    (record.thumbnail_url === undefined || typeof record.thumbnail_url === "string")
  );
}

function buildOembedRequestUrl(youtubeVideoId: string): URL {
  const oembedUrl = new URL("https://www.youtube.com/oembed");
  oembedUrl.searchParams.set("format", "json");
  // Built from the PARSED id, never the client's string (§9). searchParams encodes the
  // nested `?v=`, which raw concatenation would leave ambiguous.
  oembedUrl.searchParams.set("url", `https://www.youtube.com/watch?v=${youtubeVideoId}`);
  return oembedUrl;
}

/**
 * Proves a video exists, is public and permits embedding — the one outbound request the
 * create path makes (§9). No API key, no quota: this is oEmbed, not the YouTube Data API.
 *
 * Outcomes:
 *   200                          → verified; take `title` and `thumbnail_url`.
 *   400 / 401 / 403 / 404        → deleted, private or embedding-disabled → UNAVAILABLE.
 *   429 / 5xx / timeout / throw  → VERIFY_FAILED. Not the creator's fault; retry may work.
 *
 * The catch is explicit and not optional: Express 5 forwards a rejected promise to the
 * error handler, so an unhandled AbortError would surface as a 500 rather than the 502
 * §9 promises.
 */
export async function verifyYoutubeVideo(
  youtubeVideoId: string,
  options: VerifyYoutubeVideoOptions = {},
): Promise<Result<YoutubeVideoFacts, YoutubeSourceError>> {
  // Defence in depth. Every caller reaches here through extractYoutubeVideoId, but this
  // id is what gets interpolated into an outbound URL, so it is re-proven at the point of
  // use rather than trusted from a caller that might change.
  if (!YOUTUBE_VIDEO_ID_PATTERN.test(youtubeVideoId)) {
    return { success: false, error: { type: "INVALID_YOUTUBE_URL" } };
  }

  const nowEpochMs = Date.now();
  const cachedOutcome = readCachedOutcome(youtubeVideoId, nowEpochMs);
  if (cachedOutcome) {
    return cachedOutcome.kind === "verified"
      ? { success: true, value: cachedOutcome.facts }
      : { success: false, error: { type: "YOUTUBE_VIDEO_UNAVAILABLE", youtubeVideoId } };
  }

  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_OEMBED_TIMEOUT_MS;

  let response: Response;
  try {
    response = await fetchImplementation(buildOembedRequestUrl(youtubeVideoId), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // A timeout, a DNS failure or a socket reset. Deliberately not cached.
    return { success: false, error: { type: "YOUTUBE_VERIFY_FAILED" } };
  }

  if (!response.ok) {
    if (response.status >= 500 || response.status === 429) {
      return { success: false, error: { type: "YOUTUBE_VERIFY_FAILED" } };
    }
    // 400/401/403/404 and any other 4xx: the link is the problem, so the creator is told
    // to fix it rather than to try again.
    writeCachedOutcome(youtubeVideoId, { kind: "unavailable" }, nowEpochMs);
    return { success: false, error: { type: "YOUTUBE_VIDEO_UNAVAILABLE", youtubeVideoId } };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    // A 200 whose body is not JSON is not a proof of anything. Retryable.
    return { success: false, error: { type: "YOUTUBE_VERIFY_FAILED" } };
  }

  if (!isYoutubeOembedPayload(payload)) {
    return { success: false, error: { type: "YOUTUBE_VERIFY_FAILED" } };
  }

  const trimmedTitle = payload.title?.trim() ?? "";
  const facts: YoutubeVideoFacts = {
    suggestedTitle: trimmedTitle === "" ? null : trimmedTitle.slice(0, MAX_SUGGESTED_TITLE_LENGTH),
    thumbnailUrl: payload.thumbnail_url ? sanitizeYoutubeThumbnailUrl(payload.thumbnail_url) : null,
  };

  writeCachedOutcome(youtubeVideoId, { kind: "verified", facts }, nowEpochMs);
  return { success: true, value: facts };
}
