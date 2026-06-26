/**
 * Extraction of profile data (display name, avatar, email) from already-stored
 * OAuth provider artifacts. Shared by:
 *
 *   - the account.create hook in src/lib/auth.ts (write-once at link time), and
 *   - scripts/backfill-oauth-profile.ts (one-time backfill of older rows).
 *
 * Two providers, two sources:
 *   - google → decode the stored `id_token` (a Google-signed JWT) for `name`,
 *              `picture`, and the verified `email` claim.
 *   - github → call the GitHub REST API with the stored `access_token`
 *              (GET /user for name+avatar, GET /user/emails for the email).
 *
 * The id_token is trusted because Google issued it over TLS during the original
 * OAuth ceremony and we persisted it in our own DB; we decode (not re-verify) the
 * payload — the trust boundary is our database, not this decode. Every provider
 * payload is parsed with Zod before use (untrusted-shape discipline, CLAUDE.md §2).
 */
import { z } from "zod";

import type { Result } from "#src/types/index.js";

/** Profile fields we lift off a provider. Everything optional — never assume shape. */
export interface ProviderProfile {
  readonly name?: string;
  readonly image?: string;
  readonly email?: string;
}

/**
 * Claims we read out of a Google id_token. `email` is only usable when
 * `email_verified` is true — an unverified address must never be surfaced as the
 * account's email (it could be attacker-controlled).
 */
const GoogleIdTokenClaimsSchema = z.object({
  name: z.string().min(1).optional(),
  picture: z.string().url().optional(),
  email: z.string().email().optional(),
  email_verified: z.boolean().optional(),
});

/** Subset of GET https://api.github.com/user we use. `name` can be null on GitHub. */
const GitHubUserSchema = z.object({
  name: z.string().min(1).nullable().optional(),
  login: z.string().min(1),
  avatar_url: z.string().url(),
});

/**
 * Subset of GET https://api.github.com/user/emails. The endpoint returns every
 * address the user has on file; we want the one that is both `primary` and
 * `verified`. Unverified addresses are ignored for the same reason as Google.
 */
const GitHubEmailSchema = z.object({
  email: z.string().email(),
  primary: z.boolean(),
  verified: z.boolean(),
});
const GitHubEmailsSchema = z.array(GitHubEmailSchema);

/**
 * Decode (without signature verification) the payload of a Google id_token JWT and
 * pull name, picture and the verified email. Returns the parsed profile or a
 * reason string. The email is included ONLY when the `email_verified` claim is true.
 */
export function readGoogleProfileFromIdToken(idToken: string): Result<ProviderProfile, string> {
  const segments = idToken.split(".");
  if (segments.length !== 3) {
    return { success: false, error: "id_token is not a well-formed JWT" };
  }

  let claimsJson: unknown;
  try {
    const payloadJson = Buffer.from(segments[1], "base64url").toString("utf8");
    claimsJson = JSON.parse(payloadJson);
  } catch {
    return { success: false, error: "id_token payload is not valid base64url JSON" };
  }

  const parsed = GoogleIdTokenClaimsSchema.safeParse(claimsJson);
  if (!parsed.success) {
    return { success: false, error: "id_token claims failed validation" };
  }

  return {
    success: true,
    value: {
      name: parsed.data.name,
      image: parsed.data.picture,
      // Drop an unverified address — only a proven-owned email may be stored.
      email: parsed.data.email_verified ? parsed.data.email : undefined,
    },
  };
}

/**
 * Fetch the GitHub profile (name + avatar) for a stored access token. The token may
 * be expired/revoked, so any non-200 (or shape mismatch) is a soft failure the
 * caller skips over.
 */
export async function fetchGitHubProfile(
  accessToken: string,
): Promise<Result<ProviderProfile, string>> {
  let response: Response;
  try {
    response = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "qatoto-backfill",
      },
    });
  } catch {
    return { success: false, error: "GitHub request failed (network)" };
  }

  if (!response.ok) {
    return { success: false, error: `GitHub returned ${response.status}` };
  }

  const parsed = GitHubUserSchema.safeParse(await response.json());
  if (!parsed.success) {
    return { success: false, error: "GitHub response failed validation" };
  }

  return {
    success: true,
    value: { name: parsed.data.name ?? parsed.data.login, image: parsed.data.avatar_url },
  };
}

/**
 * Fetch the user's PRIMARY VERIFIED email from GitHub. GitHub does not put the
 * email in any stored token, so this is a live call to GET /user/emails (requires
 * the `user:email` scope, which Better Auth's github provider requests by default).
 * Returns a soft failure on any non-200, shape mismatch, or when no primary
 * verified address exists.
 */
export async function fetchGitHubPrimaryEmail(
  accessToken: string,
): Promise<Result<string, string>> {
  let response: Response;
  try {
    response = await fetch("https://api.github.com/user/emails", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "qatoto-backfill",
      },
    });
  } catch {
    return { success: false, error: "GitHub email request failed (network)" };
  }

  if (!response.ok) {
    return { success: false, error: `GitHub /user/emails returned ${response.status}` };
  }

  const parsed = GitHubEmailsSchema.safeParse(await response.json());
  if (!parsed.success) {
    return { success: false, error: "GitHub /user/emails response failed validation" };
  }

  const primaryVerified = parsed.data.find((entry) => entry.primary && entry.verified);
  if (!primaryVerified) {
    return { success: false, error: "GitHub has no primary verified email" };
  }

  return { success: true, value: primaryVerified.email };
}
