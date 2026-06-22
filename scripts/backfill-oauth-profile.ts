/**
 * One-time backfill of `user.name` / `user.image` from already-linked OAuth providers.
 *
 * `updateUserInfoOnLink` (src/lib/auth.ts) only syncs the profile on a NEW link, so
 * users whose google/github account was linked BEFORE that flag was enabled still carry
 * `image = null` and the email-prefix fallback name. This script reads the provider
 * profile already sitting in the `account` row and copies `name` + `image` onto the user:
 *
 *   - google → decode the stored `id_token` (a Google-signed JWT) → `name`, `picture`.
 *   - github → call https://api.github.com/user with the stored `access_token`
 *              → `name` (falls back to `login`), `avatar_url`.
 *
 * Conservative writes:
 *   - `image` is set ONLY when currently null (never overwrites an existing picture).
 *   - `name`  is overwritten ONLY when it still equals the email-prefix fallback
 *     (`email.split("@")[0]`) — a deliberately-chosen name is left untouched.
 *
 * The id_token is trusted because it came from Google over TLS during the original OAuth
 * ceremony and is stored in our own DB; we decode (not re-verify) its payload. Both
 * provider payloads are parsed with Zod before use (untrusted-shape discipline).
 *
 * Usage:
 *   npm run db:backfill-oauth-profile             # DRY RUN — prints planned updates
 *   npm run db:backfill-oauth-profile -- --apply  # actually writes the rows
 */
import "dotenv/config";
import { eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import { db, pool } from "#src/db/index.js";
import { account, user } from "#src/db/schema.js";

/** Claims we read out of a Google id_token. Everything optional — never assume shape. */
const GoogleIdTokenClaimsSchema = z.object({
  name: z.string().min(1).optional(),
  picture: z.string().url().optional(),
});

/** Subset of GET https://api.github.com/user we use. `name` can be null on GitHub. */
const GitHubUserSchema = z.object({
  name: z.string().min(1).nullable().optional(),
  login: z.string().min(1),
  avatar_url: z.string().url(),
});

type ProviderProfile = { readonly name?: string; readonly image?: string };

type Result<T, E = string> =
  | { success: true; value: T }
  | { success: false; error: E };

/**
 * Decode (without signature verification) the payload of a JWT id_token. The token was
 * issued by Google during OAuth and persisted by us, so the trust boundary is our DB,
 * not this decode. Returns the parsed claims or a reason string.
 */
function readGoogleProfileFromIdToken(idToken: string): Result<ProviderProfile> {
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

  return { success: true, value: { name: parsed.data.name, image: parsed.data.picture } };
}

/**
 * Fetch the GitHub profile for a stored access token. The token may be expired/revoked,
 * so any non-200 (or shape mismatch) is a soft failure the caller skips over.
 */
async function fetchGitHubProfile(accessToken: string): Promise<Result<ProviderProfile>> {
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

async function main(): Promise<void> {
  const shouldApply = process.argv.includes("--apply");

  // Only users still missing a picture are candidates — `name` is notNull so it always
  // has at least the email-prefix fallback; image=null is the reliable "never synced" mark.
  const candidates = await db
    .select({ id: user.id, email: user.email, name: user.name })
    .from(user)
    .where(isNull(user.image));

  if (candidates.length === 0) {
    console.log("No users with a missing profile picture. Nothing to do.");
    return;
  }

  const candidateIds = candidates.map((candidate) => candidate.id);

  // Pull google/github account rows for exactly those users in one query.
  const oauthAccounts = await db
    .select({
      userId: account.userId,
      providerId: account.providerId,
      idToken: account.idToken,
      accessToken: account.accessToken,
    })
    .from(account)
    .where(inArray(account.userId, candidateIds));

  // Index by user; prefer google (richer, no network call) over github.
  const accountsByUser = new Map<string, typeof oauthAccounts>();
  for (const oauthAccount of oauthAccounts) {
    if (oauthAccount.providerId !== "google" && oauthAccount.providerId !== "github") {
      continue;
    }
    const existing = accountsByUser.get(oauthAccount.userId) ?? [];
    accountsByUser.set(oauthAccount.userId, [...existing, oauthAccount]);
  }

  let updatedCount = 0;
  let skippedCount = 0;

  for (const candidate of candidates) {
    const linkedAccounts = accountsByUser.get(candidate.id) ?? [];
    const google = linkedAccounts.find((linked) => linked.providerId === "google");
    const github = linkedAccounts.find((linked) => linked.providerId === "github");

    let profileResult: Result<ProviderProfile> | null = null;
    let sourceProvider = "";

    if (google?.idToken) {
      profileResult = readGoogleProfileFromIdToken(google.idToken);
      sourceProvider = "google";
    } else if (github?.accessToken) {
      profileResult = await fetchGitHubProfile(github.accessToken);
      sourceProvider = "github";
    }

    if (!profileResult) {
      skippedCount += 1;
      console.log(`  SKIP  ${candidate.email}  — no google id_token / github access_token`);
      continue;
    }

    if (!profileResult.success) {
      skippedCount += 1;
      console.log(`  SKIP  ${candidate.email}  — ${sourceProvider}: ${profileResult.error}`);
      continue;
    }

    const emailPrefixFallback = candidate.email.split("@")[0];
    const nameIsStillFallback = candidate.name === emailPrefixFallback;

    const nextImage = profileResult.value.image;
    const nextName =
      nameIsStillFallback && profileResult.value.name ? profileResult.value.name : undefined;

    if (!nextImage && !nextName) {
      skippedCount += 1;
      console.log(`  SKIP  ${candidate.email}  — ${sourceProvider} had no usable name/image`);
      continue;
    }

    const updateFields: { name?: string; image?: string } = {};
    if (nextName) updateFields.name = nextName;
    if (nextImage) updateFields.image = nextImage;

    console.log(
      `  ${shouldApply ? "SET " : "PLAN"}  ${candidate.email}  (${sourceProvider})  ` +
        `${nextName ? `name="${nextName}" ` : ""}${nextImage ? `image="${nextImage}"` : ""}`,
    );

    if (shouldApply) {
      await db.update(user).set(updateFields).where(eq(user.id, candidate.id));
    }
    updatedCount += 1;
  }

  console.log(
    `\n${shouldApply ? "Updated" : "Would update"} ${updatedCount} user(s); skipped ${skippedCount}.`,
  );
  if (!shouldApply) {
    console.log("DRY RUN — nothing written. Re-run with `-- --apply` to persist.");
  }
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("Backfill failed:", error);
    await pool.end();
    process.exit(1);
  });
