/**
 * Grants or revokes a platform staff role (R_AND_D_BACKEND_STRUCTURE.md §4a Layer 3).
 *
 * THIS IS THE ONLY CODE IN THE REPO THAT WRITES `user.platform_role`, and it is
 * deliberately not reachable over HTTP. A self-grantable staff role would defeat
 * category moderation (§6) and the four-eyes escrow rule (§7) at once — see the column
 * comment in src/db/schema.ts. Grants are a DBA action, taken by someone with shell
 * access to a machine that already holds the database credentials.
 *
 * Roles, and what they can do (the grant table lives in
 * src/modules/platform/roles/platform-role.service.ts):
 *   moderator — approve/reject user-minted categories, decide cluster merge proposals,
 *               moderate §10 content
 *   auditor   — read the §7 escrow ledger. Read-only, and DISJOINT from moderator.
 *   admin     — both of the above
 *   none      — revokes any existing role (sets the column back to NULL)
 *
 *   pnpm db:grant-platform-role -- --email=someone@example.com --role=moderator
 *   pnpm db:grant-platform-role -- --email=someone@example.com --role=none
 *
 * Prints the before/after state so the operator can see what actually changed, and
 * refuses a no-op rather than reporting a success that did nothing.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
import { user } from "#src/db/schema.js";
import { appendPlatformAuditEntry } from "#src/modules/platform/audit/platform-audit.service.js";
import type { PlatformRole } from "#src/modules/platform/roles/platform-role.service.js";

const ASSIGNABLE_ROLES = ["moderator", "auditor", "admin"] as const;
const REVOKE_KEYWORD = "none";

function readFlag(flagName: string): string | undefined {
  const prefix = `--${flagName}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));
  return match?.slice(prefix.length);
}

function isAssignableRole(candidate: string): candidate is PlatformRole {
  // `.some` with an equality test rather than `.includes(candidate as PlatformRole)`:
  // the assertion would be a lie in the failure case, which is the case this guard
  // exists to detect (CLAUDE.md §2 — no unchecked type assertions).
  return ASSIGNABLE_ROLES.some((assignableRole) => assignableRole === candidate);
}

async function main(): Promise<void> {
  const emailArgument = readFlag("email");
  const roleArgument = readFlag("role");

  if (!emailArgument || !roleArgument) {
    throw new Error(
      `Usage: pnpm db:grant-platform-role -- --email=<address> --role=<${ASSIGNABLE_ROLES.join("|")}|${REVOKE_KEYWORD}>`,
    );
  }

  if (roleArgument !== REVOKE_KEYWORD && !isAssignableRole(roleArgument)) {
    throw new Error(
      `Unknown role "${roleArgument}". Expected one of: ${ASSIGNABLE_ROLES.join(", ")}, ${REVOKE_KEYWORD}.`,
    );
  }

  const nextPlatformRole: PlatformRole | null =
    roleArgument === REVOKE_KEYWORD ? null : roleArgument;

  // `user.email` is citext, so this match is case-insensitive by column type.
  const [existingUser] = await db
    .select({ id: user.id, email: user.email, name: user.name, platformRole: user.platformRole })
    .from(user)
    .where(eq(user.email, emailArgument))
    .limit(1);

  if (!existingUser) {
    throw new Error(`No user found with email ${emailArgument}.`);
  }

  if (existingUser.platformRole === nextPlatformRole) {
    console.log(
      `No change: ${existingUser.email} already has platform role ${existingUser.platformRole ?? "none"}.`,
    );
    return;
  }

  const [updatedUser] = await db.transaction(async (tx) => {
    const rows = await tx
      .update(user)
      .set({ platformRole: nextPlatformRole })
      .where(eq(user.id, existingUser.id))
      .returning({ email: user.email, platformRole: user.platformRole });

    if (rows.length > 0) {
      // "Who made this person a moderator, and when" had NO ANSWER IN THE DATABASE before
      // this (§11l.2 item 2). The grant is deliberately not reachable over HTTP, which
      // makes it the one privileged action with no request log behind it either.
      //
      // THE ACTOR IS THE SUBJECT, and that is a limitation worth stating rather than
      // hiding: this script runs from a shell with database credentials and has no
      // session, so the chain records WHO WAS GRANTED and when, not who typed the
      // command. The operator's identity lives in the shell history and the deploy log.
      // A `--granted-by=` flag would look like an answer and be an unverified string.
      await appendPlatformAuditEntry(tx, {
        eventKind: nextPlatformRole === null ? "platform_role_revoked" : "platform_role_granted",
        actorUserId: existingUser.id,
        actorRoleSnapshot: existingUser.platformRole ?? "none",
        actionLabel:
          nextPlatformRole === null ? "Revoked a platform role" : "Granted a platform role",
        targetLabel: `user ${existingUser.id}`,
        detailNote: `${existingUser.platformRole ?? "none"} -> ${nextPlatformRole ?? "none"}`,
        payload: {
          subjectUserId: existingUser.id,
          previousRole: existingUser.platformRole ?? "none",
          nextRole: nextPlatformRole ?? "none",
          grantedByShell: true,
        },
        occurredAt: new Date(),
      });
    }

    return rows;
  });

  if (!updatedUser) {
    throw new Error(`Update affected no rows for ${emailArgument} — the row vanished mid-update.`);
  }

  console.log(
    `Platform role changed for ${updatedUser.email} (${existingUser.name}): ` +
      `${existingUser.platformRole ?? "none"} -> ${updatedUser.platformRole ?? "none"}`,
  );
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("Platform role grant failed:", error);
    await pool.end();
    process.exit(1);
  });
