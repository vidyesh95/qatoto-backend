/**
 * External link parsing for workshop files and daily-log evidence
 * (R_AND_D_BACKEND_STRUCTURE.md §8, "Files: an external link, measured by nobody").
 *
 * WHY A LINK IS TREATED LIKE ANY OTHER HOSTILE CLIENT STRING (§0). Every URL here is
 * typed by a member or extracted by a model, stored, and then rendered by three clients
 * as an `href` a teammate will click. That makes it the same class of input as the
 * YouTube URL in src/lib/youtube.ts, and it gets the same treatment: parse it, allowlist
 * the host by EXACT match, normalize it, and store the normalized form — never the
 * original string.
 *
 * The specific attacks this refuses, none of them theoretical:
 *   - `javascript:` and `data:` payloads reaching an `href`.
 *   - Lookalike hosts: `drive.google.com.evil.tld` and `evil.tld/drive.google.com/x`
 *     both fall through to HOST_NOT_ALLOWED, because the check is a set membership on
 *     the parsed hostname rather than a substring test.
 *   - Credentials in the authority (`https://user:token@drive.google.com/…`), which
 *     would leak a teammate's token into the workshop file list for everyone to read.
 *
 * WHY THE ALLOWLIST IS SHORT AND EXACT. It is the whole security model of the deferred
 * object-storage path: with no bytes to scan and no size to measure, the host is the only
 * thing the server actually knows about a linked file. A permissive allowlist is the same
 * as none.
 *
 * Pure and dependency-free: no config, no network, no database. Same string in, same
 * result out.
 */

import type { Result } from "#src/types/index.js";

/** Matches `workshop_file_externalUrl_ck` and `daily_log_evidence_link_url_ck`. */
const MAX_URL_LENGTH = 2048;

/**
 * The provider a host belongs to. Mirrors `evidence_link_provider` in the schema, which
 * is why `other` exists — a host can be allowlisted for files without being a code or
 * design artifact §9 knows how to ground.
 */
export type ExternalLinkProvider =
  | "github"
  | "gitlab"
  | "figma"
  | "google_docs"
  | "notion"
  | "other";

/**
 * Hosts accepted by EXACT match, lowercased. Order is irrelevant; membership is a set
 * lookup.
 *
 * `dl.dropboxusercontent.com` is included because Dropbox rewrites share links to it,
 * so refusing it would reject a URL the member legitimately copied out of Dropbox.
 */
const ALLOWED_HOSTS: ReadonlyMap<string, ExternalLinkProvider> = new Map([
  ["drive.google.com", "google_docs"],
  ["docs.google.com", "google_docs"],
  ["dropbox.com", "other"],
  ["www.dropbox.com", "other"],
  ["dl.dropboxusercontent.com", "other"],
  ["github.com", "github"],
  ["www.github.com", "github"],
  ["gist.github.com", "github"],
  ["raw.githubusercontent.com", "github"],
  ["gitlab.com", "gitlab"],
  ["www.gitlab.com", "gitlab"],
  ["onedrive.live.com", "other"],
  ["1drv.ms", "other"],
  ["figma.com", "figma"],
  ["www.figma.com", "figma"],
  ["notion.so", "notion"],
  ["www.notion.so", "notion"],
]);

/**
 * Suffix rules, for providers that give every workspace its own subdomain.
 *
 * The LEADING DOT is load-bearing: matching on `"notion.site"` alone would accept
 * `evil-notion.site`, which is precisely the lookalike this module exists to refuse.
 */
const ALLOWED_HOST_SUFFIXES: readonly (readonly [string, ExternalLinkProvider])[] = [
  [".notion.site", "notion"],
];

export type ExternalLinkError =
  | { type: "LINK_UNPARSEABLE" }
  | { type: "LINK_NOT_HTTPS"; scheme: string }
  | { type: "LINK_HOST_NOT_ALLOWED"; host: string }
  | { type: "LINK_TOO_LONG"; length: number };

export interface ParsedExternalLink {
  /** Credentials and fragment stripped, host lowercased. THIS is what gets stored. */
  readonly normalizedUrl: string;
  readonly host: string;
  readonly provider: ExternalLinkProvider;
}

function resolveProvider(host: string): ExternalLinkProvider | null {
  const exactMatch = ALLOWED_HOSTS.get(host);
  if (exactMatch !== undefined) {
    return exactMatch;
  }

  const suffixMatch = ALLOWED_HOST_SUFFIXES.find(([suffix]) => host.endsWith(suffix));
  return suffixMatch ? suffixMatch[1] : null;
}

/**
 * Parses and allowlists a link, returning the normalized form to store.
 *
 * The query string is DELIBERATELY PRESERVED — Drive's `?usp=sharing` and Dropbox's
 * `?dl=0` are load-bearing parts of a share link, and stripping them hands the team a URL
 * that 404s. The fragment is dropped: it never reaches a server, so it carries no
 * addressing information, and it is a common place to hide a lookalike path.
 */
export function parseExternalLink(rawUrl: string): Result<ParsedExternalLink, ExternalLinkError> {
  const trimmedUrl = rawUrl.trim();

  if (trimmedUrl.length > MAX_URL_LENGTH) {
    return { success: false, error: { type: "LINK_TOO_LONG", length: trimmedUrl.length } };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmedUrl);
  } catch {
    // No schemeless fallback here, unlike the YouTube parser: a bare `drive.google.com/x`
    // is ambiguous, and guessing `https://` for a security-sensitive allowlist means
    // guessing which host the member meant.
    return { success: false, error: { type: "LINK_UNPARSEABLE" } };
  }

  if (parsedUrl.protocol !== "https:") {
    return {
      success: false,
      // `replace` drops the trailing colon so the message reads "http", not "http:".
      error: { type: "LINK_NOT_HTTPS", scheme: parsedUrl.protocol.replace(":", "") },
    };
  }

  const host = parsedUrl.hostname.toLowerCase();
  const provider = resolveProvider(host);
  if (provider === null) {
    return { success: false, error: { type: "LINK_HOST_NOT_ALLOWED", host } };
  }

  parsedUrl.username = "";
  parsedUrl.password = "";
  parsedUrl.hash = "";

  const normalizedUrl = parsedUrl.toString();
  if (normalizedUrl.length > MAX_URL_LENGTH) {
    return { success: false, error: { type: "LINK_TOO_LONG", length: normalizedUrl.length } };
  }

  return { success: true, value: { normalizedUrl, host, provider } };
}

/**
 * The provider-specific id inside a link, when one can be parsed out.
 *
 * §9 dedupes artifacts on `(provider, externalId)` — "one commit must not fund two
 * members' claims" — so extracting it at write time is what makes that unique index
 * possible later. Returns null rather than guessing: a wrong id would merge two distinct
 * artifacts into one, which is worse than having none.
 */
export function extractExternalId(parsedLink: ParsedExternalLink): string | null {
  const pathSegments = new URL(parsedLink.normalizedUrl).pathname.split("/").filter(Boolean);

  if (parsedLink.provider === "github" && parsedLink.host === "github.com") {
    // /:owner/:repo/commit/:sha — the artifact §9 actually grounds effort on.
    const commitIndex = pathSegments.indexOf("commit");
    const commitSha = commitIndex >= 0 ? pathSegments[commitIndex + 1] : undefined;
    if (commitSha !== undefined && /^[0-9a-f]{7,40}$/i.test(commitSha)) {
      const owner = pathSegments[0];
      const repository = pathSegments[1];
      return owner !== undefined && repository !== undefined
        ? `${owner}/${repository}@${commitSha.toLowerCase()}`
        : null;
    }
    // /:owner/:repo/pull/:number
    const pullIndex = pathSegments.indexOf("pull");
    const pullNumber = pullIndex >= 0 ? pathSegments[pullIndex + 1] : undefined;
    if (pullNumber !== undefined && /^\d+$/.test(pullNumber)) {
      const owner = pathSegments[0];
      const repository = pathSegments[1];
      return owner !== undefined && repository !== undefined
        ? `${owner}/${repository}#${pullNumber}`
        : null;
    }
    return null;
  }

  if (parsedLink.provider === "figma") {
    // /file/:key/… and /design/:key/… both carry the file key in the same position.
    const keyIndex = pathSegments.findIndex(
      (segment) => segment === "file" || segment === "design",
    );
    const fileKey = keyIndex >= 0 ? pathSegments[keyIndex + 1] : undefined;
    return fileKey ?? null;
  }

  if (parsedLink.provider === "google_docs") {
    // /document/d/:id/edit, /spreadsheets/d/:id/…, /file/d/:id/view
    const documentIdIndex = pathSegments.indexOf("d");
    const documentId = documentIdIndex >= 0 ? pathSegments[documentIdIndex + 1] : undefined;
    return documentId ?? null;
  }

  return null;
}
