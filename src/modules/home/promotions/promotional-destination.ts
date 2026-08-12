/**
 * Destination parsing for home-page promotional slides.
 *
 * A slide's destination is rendered by the frontend as an `href` that EVERY VISITOR to the
 * front page can click, so it gets the same treatment as any other hostile client string
 * (CLAUDE.md §1.1): parse it, refuse the dangerous shapes structurally, normalize it, and
 * store the normalized form rather than what was typed.
 *
 * WHY NOT `parseExternalLink` FROM src/lib/external-link.ts. Same shape, deliberately
 * different policy. That module is a sixteen-host ALLOWLIST for workshop evidence (drive,
 * github, figma, …) and would reject every advertiser on earth. Here the external arm has
 * to accept an arbitrary third-party host, so the protection has to come from the scheme,
 * the authority and the absence of credentials instead of from a host set.
 *
 * The specific attacks the internal arm refuses, none of them theoretical:
 *   - `//evil.tld/x` — a PROTOCOL-RELATIVE URL. It starts with "/", so the obvious
 *     `startsWith("/")` check passes it, and `<Link href="//evil.tld/x">` navigates
 *     straight off-site. This is THE open-redirect bug this module exists to prevent.
 *   - `/\evil.tld` — the same attack spelled with a backslash. WHATWG URL normalizes a
 *     backslash to a slash for special schemes, so a browser reads it as protocol-relative
 *     too.
 *   - `javascript:alert(1)` and `data:` payloads reaching an `href`.
 *   - Whitespace and control characters, which are how a value gets one meaning in a
 *     validator and another in a browser.
 *
 * Pure and dependency-free: no config, no network, no database. Same string in, same
 * result out.
 */

import type { Result } from "#src/types/index.js";

/** Matches the internal arm of `promotional_slide_destination_ck`. */
const MAX_INTERNAL_PATH_LENGTH = 512;

/** Matches the external arm of `promotional_slide_destination_ck`. */
const MAX_EXTERNAL_URL_LENGTH = 2048;

/**
 * A base origin used only to resolve a relative path so it can be re-serialized and
 * compared. `.invalid` is reserved by RFC 2606 and can never resolve, so this string can
 * never become a real request even if it escaped into a stored value by mistake.
 */
const INTERNAL_PATH_SENTINEL_ORIGIN = "https://promotional-slide.invalid";

/** Mirrors `promotional_destination_kind` in the schema. snake_case, sent verbatim. */
export type PromotionalDestinationKind = "internal_path" | "external_url";

export type PromotionalDestinationError =
  | { type: "DESTINATION_EMPTY" }
  | { type: "DESTINATION_TOO_LONG"; length: number; maximum: number }
  | { type: "DESTINATION_HAS_ILLEGAL_CHARACTERS" }
  /** Did not start with a single "/". */
  | { type: "INTERNAL_PATH_NOT_RELATIVE" }
  /** Started with "//" or "/\" — leaves the site. */
  | { type: "INTERNAL_PATH_LEAVES_SITE" }
  | { type: "EXTERNAL_URL_UNPARSEABLE" }
  | { type: "EXTERNAL_URL_NOT_HTTPS"; scheme: string }
  | { type: "EXTERNAL_URL_HOST_INVALID"; host: string }
  | { type: "EXTERNAL_URL_HAS_CREDENTIALS" };

export interface ParsedPromotionalDestination {
  readonly kind: PromotionalDestinationKind;
  /** THIS is what gets stored — never the raw input. */
  readonly normalizedValue: string;
}

/** Anything a URL parser and a browser might disagree about. */
// eslint-disable-next-line no-control-regex -- control characters ARE the payload here
const ILLEGAL_CHARACTERS = /[\u0000-\u0020\u007F]/;

/**
 * Parses a same-site path.
 *
 * The round-trip identity check is the load-bearing part: resolve against a sentinel
 * origin, then require BOTH that the origin is still the sentinel AND that re-serializing
 * path+search+hash reproduces the input byte for byte. That single test subsumes every
 * protocol-relative spelling, including ones not enumerated above, because anything the
 * URL parser reads as an authority changes the origin or the serialization. The two
 * explicit prefix refusals run first only so the caller gets a message naming the actual
 * mistake rather than a generic one.
 */
function parseInternalPath(
  trimmedValue: string,
): Result<ParsedPromotionalDestination, PromotionalDestinationError> {
  if (trimmedValue.length > MAX_INTERNAL_PATH_LENGTH) {
    return {
      success: false,
      error: {
        type: "DESTINATION_TOO_LONG",
        length: trimmedValue.length,
        maximum: MAX_INTERNAL_PATH_LENGTH,
      },
    };
  }

  if (!trimmedValue.startsWith("/")) {
    return { success: false, error: { type: "INTERNAL_PATH_NOT_RELATIVE" } };
  }

  if (trimmedValue.startsWith("//") || trimmedValue.startsWith("/\\")) {
    return { success: false, error: { type: "INTERNAL_PATH_LEAVES_SITE" } };
  }

  let resolvedUrl: URL;
  try {
    resolvedUrl = new URL(trimmedValue, INTERNAL_PATH_SENTINEL_ORIGIN);
  } catch {
    return { success: false, error: { type: "INTERNAL_PATH_NOT_RELATIVE" } };
  }

  const reserialized = `${resolvedUrl.pathname}${resolvedUrl.search}${resolvedUrl.hash}`;
  if (resolvedUrl.origin !== INTERNAL_PATH_SENTINEL_ORIGIN || reserialized !== trimmedValue) {
    return { success: false, error: { type: "INTERNAL_PATH_LEAVES_SITE" } };
  }

  return { success: true, value: { kind: "internal_path", normalizedValue: trimmedValue } };
}

/**
 * Parses an external advertiser destination.
 *
 * The query string is PRESERVED — campaign parameters are the whole point of an ad link
 * and stripping them hands the advertiser a URL that loses their attribution. The fragment
 * is dropped: it never reaches a server, so it carries no addressing information, and it
 * is a common place to hide a lookalike path.
 *
 * A host with no dot is refused because it can only be an intranet name or a bare label —
 * neither is a public advertiser, and both are the shape used to point a link at something
 * inside the visitor's own network.
 */
function parseExternalUrl(
  trimmedValue: string,
): Result<ParsedPromotionalDestination, PromotionalDestinationError> {
  if (trimmedValue.length > MAX_EXTERNAL_URL_LENGTH) {
    return {
      success: false,
      error: {
        type: "DESTINATION_TOO_LONG",
        length: trimmedValue.length,
        maximum: MAX_EXTERNAL_URL_LENGTH,
      },
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmedValue);
  } catch {
    // No schemeless fallback: guessing "https://" for a value that will become an href
    // means guessing which host the admin meant.
    return { success: false, error: { type: "EXTERNAL_URL_UNPARSEABLE" } };
  }

  if (parsedUrl.protocol !== "https:") {
    return {
      success: false,
      // `replace` drops the trailing colon so the message reads "http", not "http:".
      error: { type: "EXTERNAL_URL_NOT_HTTPS", scheme: parsedUrl.protocol.replace(":", "") },
    };
  }

  if (parsedUrl.username !== "" || parsedUrl.password !== "") {
    return { success: false, error: { type: "EXTERNAL_URL_HAS_CREDENTIALS" } };
  }

  const host = parsedUrl.hostname.toLowerCase();
  if (host.length === 0 || !host.includes(".") || host.startsWith(".") || host.endsWith(".")) {
    return { success: false, error: { type: "EXTERNAL_URL_HOST_INVALID", host } };
  }

  parsedUrl.hash = "";
  const normalizedValue = parsedUrl.toString();

  if (normalizedValue.length > MAX_EXTERNAL_URL_LENGTH) {
    return {
      success: false,
      error: {
        type: "DESTINATION_TOO_LONG",
        length: normalizedValue.length,
        maximum: MAX_EXTERNAL_URL_LENGTH,
      },
    };
  }

  return { success: true, value: { kind: "external_url", normalizedValue } };
}

/**
 * Parses a slide destination of the given kind and returns the value to store.
 *
 * The KIND IS THE DISCRIMINATOR and is never inferred from the value — an admin who picked
 * "a page on Qatoto" and typed an absolute URL gets a validation error naming that
 * mismatch, rather than silently getting an external link they did not intend to create.
 */
export function parsePromotionalDestination(
  kind: PromotionalDestinationKind,
  rawValue: string,
): Result<ParsedPromotionalDestination, PromotionalDestinationError> {
  const trimmedValue = rawValue.trim();

  if (trimmedValue.length === 0) {
    return { success: false, error: { type: "DESTINATION_EMPTY" } };
  }

  if (ILLEGAL_CHARACTERS.test(trimmedValue)) {
    return { success: false, error: { type: "DESTINATION_HAS_ILLEGAL_CHARACTERS" } };
  }

  return kind === "internal_path"
    ? parseInternalPath(trimmedValue)
    : parseExternalUrl(trimmedValue);
}
