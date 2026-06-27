/**
 * One-time merge of two duplicate `user` rows that share the same email.
 *
 * How a duplicate happened: before the `citext` migration (drizzle/0008), the
 * `user.email` UNIQUE constraint was case-sensitive. Signing in with Google
 * ("User@x.com") then GitHub ("user@x.com") created TWO users — both passed the
 * constraint because the strings differ by case — so the providers never linked
 * onto one account. citext fixes this going forward; this script cleans up the
 * rows that already split, by folding the DUPLICATE user into the one you KEEP.
 *
 * What it does (inside ONE transaction):
 *   1. Re-points the duplicate's `account` rows at the kept user. If the kept user
 *      already holds the exact same provider account (same providerId+accountId),
 *      the duplicate's row is deleted instead of creating a redundant link.
 *   2. Deletes the duplicate `user`. FK `onDelete: cascade` removes its leftover
 *      `session` / `passkey` / `handle_reservations` rows.
 *
 * RUN THIS BEFORE applying drizzle/0008 (the citext migration): once email is
 * citext, the two case-differing rows collide and the migration's ALTER fails.
 *
 * Usage:
 *   # 1) DISCOVER — list every user (and their accounts) sharing an email:
 *   pnpm db:merge-duplicate-user -- --email=you@example.com
 *
 *   # 2) DRY RUN — show exactly what the merge would do (writes nothing):
 *   pnpm db:merge-duplicate-user -- --keep=<userId> --remove=<userId>
 *
 *   # 3) APPLY — perform the merge in a transaction:
 *   pnpm db:merge-duplicate-user -- --keep=<userId> --remove=<userId> --apply
 */
import "dotenv/config";
import { eq, sql } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
import { account, user } from "#src/db/schema.js";

function readFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));
  return match?.slice(prefix.length);
}

/** DISCOVER mode: print every user that shares an email (case-insensitive), with accounts. */
async function discoverByEmail(email: string): Promise<void> {
  // citext-safe even before the migration: compare on lower(email).
  const matchingUsers = await db
    .select({ id: user.id, email: user.email, createdAt: user.createdAt })
    .from(user)
    .where(sql`lower(${user.email}) = lower(${email})`);

  if (matchingUsers.length === 0) {
    console.log(`No users found for ${email}.`);
    return;
  }

  console.log(`Found ${matchingUsers.length} user(s) sharing ${email}:\n`);
  for (const matchingUser of matchingUsers) {
    const accounts = await db
      .select({ providerId: account.providerId, accountId: account.accountId })
      .from(account)
      .where(eq(account.userId, matchingUser.id));
    const providerList =
      accounts.length > 0
        ? accounts.map((row) => row.providerId).join(", ")
        : "(no accounts — orphan)";
    console.log(
      `  id=${matchingUser.id}  email=${matchingUser.email}  ` +
        `created=${matchingUser.createdAt.toISOString()}  providers=[${providerList}]`,
    );
  }

  if (matchingUsers.length < 2) {
    console.log("\nOnly one user — nothing to merge.");
    return;
  }
  console.log(
    "\nPick the user to KEEP (usually the one with the credential/password account, " +
      "else the earliest created) and the one to REMOVE, then re-run with " +
      "`--keep=<id> --remove=<id>` (add `--apply` to perform it).",
  );
}

/** MERGE mode: fold `removeUserId` into `keepUserId`. */
async function mergeUsers(
  keepUserId: string,
  removeUserId: string,
  shouldApply: boolean,
): Promise<void> {
  if (keepUserId === removeUserId) {
    throw new Error("--keep and --remove must be different user ids.");
  }

  const [keepUser] = await db.select().from(user).where(eq(user.id, keepUserId)).limit(1);
  const [removeUser] = await db.select().from(user).where(eq(user.id, removeUserId)).limit(1);
  if (!keepUser) throw new Error(`--keep user not found: ${keepUserId}`);
  if (!removeUser) throw new Error(`--remove user not found: ${removeUserId}`);

  if (keepUser.email.toLowerCase() !== removeUser.email.toLowerCase()) {
    throw new Error(
      `Refusing to merge: emails differ beyond case ` +
        `(keep="${keepUser.email}", remove="${removeUser.email}"). ` +
        `Merge is only safe for same-email duplicates.`,
    );
  }

  const keepAccounts = await db
    .select({ providerId: account.providerId, accountId: account.accountId })
    .from(account)
    .where(eq(account.userId, keepUserId));
  const keepAccountKeys = new Set(keepAccounts.map((row) => `${row.providerId}:${row.accountId}`));

  const removeAccounts = await db
    .select({ id: account.id, providerId: account.providerId, accountId: account.accountId })
    .from(account)
    .where(eq(account.userId, removeUserId));

  console.log(
    `Merging user ${removeUserId} INTO ${keepUserId} (email ${keepUser.email}).\n` +
      `  keep currently holds:   [${keepAccounts.map((row) => row.providerId).join(", ") || "none"}]\n` +
      `  remove currently holds: [${removeAccounts.map((row) => row.providerId).join(", ") || "none"}]\n`,
  );

  for (const removeAccount of removeAccounts) {
    const isDuplicateOfKept = keepAccountKeys.has(
      `${removeAccount.providerId}:${removeAccount.accountId}`,
    );
    if (isDuplicateOfKept) {
      console.log(
        `  ${shouldApply ? "DROP" : "PLAN-DROP"}  account ${removeAccount.id} ` +
          `(${removeAccount.providerId}) — kept user already has this provider account`,
      );
    } else {
      console.log(
        `  ${shouldApply ? "MOVE" : "PLAN-MOVE"}  account ${removeAccount.id} ` +
          `(${removeAccount.providerId}) → user ${keepUserId}`,
      );
    }
  }
  console.log(
    `  ${shouldApply ? "DELETE" : "PLAN-DELETE"}  user ${removeUserId} ` +
      `(cascades its sessions / passkeys / handle reservations)\n`,
  );

  if (!shouldApply) {
    console.log("DRY RUN — nothing written. Re-run with `--apply` to perform the merge.");
    return;
  }

  await db.transaction(async (tx) => {
    for (const removeAccount of removeAccounts) {
      const isDuplicateOfKept = keepAccountKeys.has(
        `${removeAccount.providerId}:${removeAccount.accountId}`,
      );
      if (isDuplicateOfKept) {
        await tx.delete(account).where(eq(account.id, removeAccount.id));
      } else {
        await tx
          .update(account)
          .set({ userId: keepUserId })
          .where(eq(account.id, removeAccount.id));
      }
    }
    // FK cascades remove the duplicate's sessions, passkeys, and handle reservations.
    await tx.delete(user).where(eq(user.id, removeUserId));
  });

  console.log(`Done. Merged ${removeUserId} into ${keepUserId}.`);
}

async function main(): Promise<void> {
  const email = readFlag("email");
  const keepUserId = readFlag("keep");
  const removeUserId = readFlag("remove");
  const shouldApply = process.argv.includes("--apply");

  if (email) {
    await discoverByEmail(email);
    return;
  }

  if (keepUserId && removeUserId) {
    await mergeUsers(keepUserId, removeUserId, shouldApply);
    return;
  }

  console.log(
    "Usage:\n" +
      "  pnpm db:merge-duplicate-user -- --email=<addr>                       # discover duplicates\n" +
      "  pnpm db:merge-duplicate-user -- --keep=<id> --remove=<id>            # dry run\n" +
      "  pnpm db:merge-duplicate-user -- --keep=<id> --remove=<id> --apply    # perform merge",
  );
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("Merge failed:", error);
    await pool.end();
    process.exit(1);
  });
