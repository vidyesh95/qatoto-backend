/**
 * Parsing for a user-supplied URL that this platform will render as an `href` FOR OTHER
 * PEOPLE.
 *
 * The policy: https only, any host, no credentials, no control characters, normalized on
 * the way in. Same treatment as any other hostile client string (CLAUDE.md §1.1) — parse
 * it, refuse the dangerous shapes structurally, and store the normalized form rather than
 * what was typed.
 *
 * WHY THIS IS NOT `src/modules/rnd/external-link.ts`. Same shape, deliberately different
 * policy. That module is a sixteen-host ALLOWLIST for workshop evidence (drive, github,
 * figma, …). Here the host is arbitrary by design — a founder's crowdfunding page is on
 * whichever platform they chose — so the protection comes from the scheme, the authority
 * and the absence of credentials instead of from a host set.
 *
 * WHY IT LIVES IN `src/lib` RATHER THAN IN ONE MODULE. Two unrelated surfaces need exactly
 * this policy: a promotional slide's external destination (§home) and a pitch's funding and
 * contact links (§12). `promotional-destination.ts` had the only implementation and its own
 * header already argued against there being a third URL parser in this codebase; a copy in
 * the pitches module would have made a fourth. That module keeps its own error vocabulary
 * and delegates the actual parsing here.
 *
 * The specific attacks this refuses, none of them theoretical:
 *   - `javascript:alert(1)` and `data:` payloads reaching an `href`.
 *   - `https://user:pass@host/` — credentials in a URL, which browsers strip from the
 *     display and phishers rely on.
 *   - Whitespace and control characters, which are how a value gets one meaning in a
 *     validator and another in a browser.
 *   - A host with no dot, which can only be an intranet name or a bare label — neither is
 *     a public destination, and both are the shape used to point a link at something
 *     inside the visitor's own network.
 *
 * Pure and dependency-free: no config, no network, no database. Same string in, same
 * result out.
 */

import type { Result } from "#src/types/index.js";

/**
 * Matches the external arm of `promotional_slide_destination_ck` and of
 * `pitch_external_urls_ck`. Both CHECKs are the backstop for this function, not a second
 * opinion — keep the three in step.
 */
export const MAX_EXTERNAL_URL_LENGTH = 2048;

export type ExternalUrlError =
  | { type: "EXTERNAL_URL_EMPTY" }
  | { type: "EXTERNAL_URL_TOO_LONG"; length: number; maximum: number }
  | { type: "EXTERNAL_URL_HAS_ILLEGAL_CHARACTERS" }
  | { type: "EXTERNAL_URL_UNPARSEABLE" }
  | { type: "EXTERNAL_URL_NOT_HTTPS"; scheme: string }
  | { type: "EXTERNAL_URL_HOST_INVALID"; host: string }
  | { type: "EXTERNAL_URL_HAS_CREDENTIALS" };

/** Anything a URL parser and a browser might disagree about. */
// eslint-disable-next-line no-control-regex -- control characters ARE the payload here
const ILLEGAL_CHARACTERS = /[\u0000-\u0020\u007F]/;

/**
 * Parses an absolute https URL and returns the NORMALIZED string to store.
 *
 * The fragment is dropped and the query string is kept: a `?ref=` or a campaign parameter
 * is part of where the founder meant to send people, while a fragment is a client-side
 * scroll target that only adds a way for two stored values to differ without meaning
 * anything different.
 *
 * The length is checked twice — before parsing and after normalizing — because
 * normalization can lengthen a value (percent-encoding, an added trailing slash) and the
 * column CHECK measures what is stored, not what was typed.
 */
export function parseHttpsUrl(rawValue: string): Result<string, ExternalUrlError> {
  const trimmedValue = rawValue.trim();

  if (trimmedValue.length === 0) {
    return { success: false, error: { type: "EXTERNAL_URL_EMPTY" } };
  }

  if (ILLEGAL_CHARACTERS.test(trimmedValue)) {
    return { success: false, error: { type: "EXTERNAL_URL_HAS_ILLEGAL_CHARACTERS" } };
  }

  if (trimmedValue.length > MAX_EXTERNAL_URL_LENGTH) {
    return {
      success: false,
      error: {
        type: "EXTERNAL_URL_TOO_LONG",
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
    // means guessing which host the author meant.
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
        type: "EXTERNAL_URL_TOO_LONG",
        length: normalizedValue.length,
        maximum: MAX_EXTERNAL_URL_LENGTH,
      },
    };
  }

  return { success: true, value: normalizedValue };
}
