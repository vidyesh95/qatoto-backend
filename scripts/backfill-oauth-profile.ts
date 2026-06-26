/**
 * One-time backfill from already-linked OAuth providers. Two independent passes:
 *
 *   1. user.name / user.image — OAuth seeds the profile only at user creation
 *      (link-time sync is OFF — see `updateUserInfoOnLink` in src/lib/auth.ts), so
 *      users whose google/github account was linked to an already-existing row
 *      still carry `image = null` and the email-prefix fallback name.
 *
 *   2. account.email — the `account.email` column (added later) is only populated
 *      by the account.create hook going forward, so accounts linked before it
 *      shipped have `email = null`. This pass fills them from the same sources.
 *
 * Provider sources (shared with the runtime hook via src/lib/oauth-profile.ts):
 *   - google → decode the stored `id_token` (a Google-signed JWT) → name, picture,
 *              verified email.
 *   - github → GET https://api.github.com/user (name, avatar) and GET
 *              /user/emails (primary verified email) with the stored access_token.
 *
 * Conservative writes:
 *   - `image` is set ONLY when currently null (never overwrites an existing picture).
 *   - `name`  is overwritten ONLY when it still equals the email-prefix fallback
 *     (`email.split("@")[0]`) — a deliberately-chosen name is left untouched.
 *   - `account.email` is set ONLY when currently null (write-once, never clobbered).
 *
 * Usage:
 *   npm run db:backfill-oauth-profile             # DRY RUN — prints planned updates
 *   npm run db:backfill-oauth-profile -- --apply  # actually writes the rows
 */
import "dotenv/config";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
import { account, user } from "#src/db/schema.js";
import {
  fetchGitHubPrimaryEmail,
  fetchGitHubProfile,
  readGoogleProfileFromIdToken,
  type ProviderProfile,
} from "#src/lib/oauth-profile.js";
import type { Result } from "#src/types/index.js";

/**
 * Pass 1 — backfill user.name / user.image from the provider profile.
 */
async function backfillUserProfiles(shouldApply: boolean): Promise<void> {
  // Only users still missing a picture are candidates — `name` is notNull so it always
  // has at least the email-prefix fallback; image=null is the reliable "never synced" mark.
  const candidates = await db
    .select({ id: user.id, email: user.email, name: user.name, nameSetByUser: user.nameSetByUser })
    .from(user)
    .where(isNull(user.image));

  if (candidates.length === 0) {
    console.log("Profile pass: no users with a missing profile picture. Nothing to do.");
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

    let profileResult: Result<ProviderProfile, string> | null = null;
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
    // Only touch the name if the user never set it themselves AND it's still the
    // email-prefix placeholder (covers the edge where a user deliberately sets
    // their name to exactly that prefix — the flag wins).
    const nameIsStillFallback = !candidate.nameSetByUser && candidate.name === emailPrefixFallback;

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
    `Profile pass: ${shouldApply ? "updated" : "would update"} ${updatedCount} user(s); skipped ${skippedCount}.`,
  );
}

/**
 * Pass 2 — backfill account.email for google/github accounts still missing it.
 */
async function backfillAccountEmails(shouldApply: boolean): Promise<void> {
  const candidates = await db
    .select({
      id: account.id,
      providerId: account.providerId,
      idToken: account.idToken,
      accessToken: account.accessToken,
    })
    .from(account)
    .where(and(isNull(account.email), inArray(account.providerId, ["google", "github"])));

  if (candidates.length === 0) {
    console.log("Email pass: no google/github accounts missing an email. Nothing to do.");
    return;
  }

  let updatedCount = 0;
  let skippedCount = 0;

  for (const candidate of candidates) {
    let emailResult: Result<string, string> | null = null;

    if (candidate.providerId === "google" && candidate.idToken) {
      const googleProfile = readGoogleProfileFromIdToken(candidate.idToken);
      emailResult = googleProfile.success
        ? googleProfile.value.email
          ? { success: true, value: googleProfile.value.email }
          : { success: false, error: "id_token had no verified email" }
        : { success: false, error: googleProfile.error };
    } else if (candidate.providerId === "github" && candidate.accessToken) {
      emailResult = await fetchGitHubPrimaryEmail(candidate.accessToken);
    }

    if (!emailResult) {
      skippedCount += 1;
      console.log(`  SKIP  account ${candidate.id} (${candidate.providerId}) — no usable token`);
      continue;
    }

    if (!emailResult.success) {
      skippedCount += 1;
      console.log(
        `  SKIP  account ${candidate.id} (${candidate.providerId}) — ${emailResult.error}`,
      );
      continue;
    }

    console.log(
      `  ${shouldApply ? "SET " : "PLAN"}  account ${candidate.id} (${candidate.providerId})  ` +
        `email="${emailResult.value}"`,
    );

    if (shouldApply) {
      await db
        .update(account)
        .set({ email: emailResult.value })
        .where(eq(account.id, candidate.id));
    }
    updatedCount += 1;
  }

  console.log(
    `Email pass: ${shouldApply ? "updated" : "would update"} ${updatedCount} account(s); skipped ${skippedCount}.`,
  );
}

async function main(): Promise<void> {
  const shouldApply = process.argv.includes("--apply");

  await backfillUserProfiles(shouldApply);
  await backfillAccountEmails(shouldApply);

  if (!shouldApply) {
    console.log("\nDRY RUN — nothing written. Re-run with `-- --apply` to persist.");
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
