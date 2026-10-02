import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "#src/db/index.js";
import { assistantCloudEntitlement, user } from "#src/db/schema.js";
import {
  decodeInstantCursor,
  encodeInstantCursor,
  type InstantCursor,
} from "#src/lib/instant-cursor.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { requirePlatformCapability } from "#src/modules/platform/roles/platform-role.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Premium AI: who may use the AI assistant's cloud route, and the admin queue that decides it.
 *
 * ## THE GATE IS ONE QUESTION, ASKED IN ONE PLACE
 *
 * `hasActiveCloudAccess` is the only reader that decides anything. `POST /assistant/replies`
 * asks it before spending a token, and `GET /assistant/cloud-access` asks it so the panel can
 * say whether chat is available. A real subscription later replaces how rows get WRITTEN; this
 * reader does not change.
 *
 * ## THE CAPABILITY IS CHECKED INSIDE, FIRST, AND BEFORE ANY QUERY
 *
 * Same reasoning as every other staff service: a route-level guard makes the capability
 * probeable, and middleware cannot return a `Result`, so it could not join the controller's
 * exhaustive switch.
 *
 * ## REVOKE NEVER DELETES
 *
 * The table is its own history (`platform.ts`). A revoke stamps the row; granting again inserts
 * a new one, which the partial unique index allows once the old one is revoked.
 */

export type AssistantCloudAccessAdminError =
  | {
      readonly type: "PLATFORM_CAPABILITY_REQUIRED";
      readonly capability: "grant_ai_assistant_cloud";
    }
  | { readonly type: "INVALID_CURSOR" }
  | { readonly type: "USER_NOT_FOUND" }
  | { readonly type: "ALREADY_GRANTED" }
  | { readonly type: "NOT_GRANTED" };

export interface AssistantCloudAccessGrant {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly handle: string | null;
  readonly grantedAt: Date;
  readonly note: string | null;
  /** Null once the staff member who granted it is anonymized. */
  readonly grantedBy: { readonly userId: string; readonly name: string } | null;
}

const CAPABILITY_REQUIRED: AssistantCloudAccessAdminError = {
  type: "PLATFORM_CAPABILITY_REQUIRED",
  capability: "grant_ai_assistant_cloud",
};

/** Does this account hold an active Premium AI grant right now? */
export async function hasActiveCloudAccess(userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: assistantCloudEntitlement.id })
    .from(assistantCloudEntitlement)
    .where(
      and(
        eq(assistantCloudEntitlement.userId, userId),
        isNull(assistantCloudEntitlement.revokedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Active grants, newest first, keyset-paged on (granted_at, id). */
export async function listActiveCloudAccessGrants(
  staffUserId: string,
  input: { readonly limit: number; readonly cursor?: string | undefined },
): Promise<
  Result<
    {
      readonly items: readonly AssistantCloudAccessGrant[];
      readonly nextCursor: string | null;
    },
    AssistantCloudAccessAdminError
  >
> {
  const capability = await requirePlatformCapability(staffUserId, "grant_ai_assistant_cloud");
  if (!capability.success) return { success: false, error: CAPABILITY_REQUIRED };

  const decodedCursor: InstantCursor | null =
    input.cursor === undefined ? null : decodeInstantCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }
  // Strictly older, OR the same instant with a smaller id: the mirror of an ascending cursor.
  const cursorCondition =
    decodedCursor === null
      ? sql`true`
      : (or(
          lt(assistantCloudEntitlement.grantedAt, decodedCursor.instant),
          and(
            eq(assistantCloudEntitlement.grantedAt, decodedCursor.instant),
            lt(assistantCloudEntitlement.id, decodedCursor.id),
          ),
        ) ?? sql`true`);

  const granter = alias(user, "granter");
  const rows = await db
    .select({
      grantId: assistantCloudEntitlement.id,
      grantedAt: assistantCloudEntitlement.grantedAt,
      note: assistantCloudEntitlement.note,
      userId: user.id,
      email: user.email,
      name: user.name,
      handle: user.handle,
      granterUserId: granter.id,
      granterName: granter.name,
    })
    .from(assistantCloudEntitlement)
    .innerJoin(user, eq(user.id, assistantCloudEntitlement.userId))
    // LEFT: the granter is nulled out when they are anonymized, and the grant still stands.
    .leftJoin(granter, eq(granter.id, assistantCloudEntitlement.grantedByUserId))
    .where(and(isNull(assistantCloudEntitlement.revokedAt), cursorCondition))
    .orderBy(desc(assistantCloudEntitlement.grantedAt), desc(assistantCloudEntitlement.id))
    .limit(input.limit + 1);

  const pageRows = rows.slice(0, input.limit);
  const lastRow = pageRows.at(-1);
  return {
    success: true,
    value: {
      items: pageRows.map((row) => ({
        userId: row.userId,
        email: row.email,
        name: row.name,
        handle: row.handle,
        grantedAt: row.grantedAt,
        note: row.note,
        grantedBy:
          row.granterUserId === null || row.granterName === null
            ? null
            : { userId: row.granterUserId, name: row.granterName },
      })),
      nextCursor:
        rows.length > input.limit && lastRow !== undefined
          ? encodeInstantCursor({ instant: lastRow.grantedAt, id: lastRow.grantId })
          : null,
    },
  };
}

/** Grant Premium AI to one account, by exact email. */
export async function grantCloudAccess(
  staffUserId: string,
  input: { readonly email: string; readonly note: string | null },
): Promise<
  Result<{ readonly userId: string; readonly grantedAt: Date }, AssistantCloudAccessAdminError>
> {
  const capability = await requirePlatformCapability(staffUserId, "grant_ai_assistant_cloud");
  if (!capability.success) return { success: false, error: CAPABILITY_REQUIRED };

  // `user.email` is citext, so this exact match is case-insensitive by column type.
  const [subject] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, input.email))
    .limit(1);
  if (subject === undefined) return { success: false, error: { type: "USER_NOT_FOUND" } };

  try {
    const [inserted] = await db
      .insert(assistantCloudEntitlement)
      .values({ userId: subject.id, grantedByUserId: staffUserId, note: input.note })
      .returning({ grantedAt: assistantCloudEntitlement.grantedAt });
    if (inserted === undefined) throw new Error("Premium AI grant insert returned no row.");
    return { success: true, value: { userId: subject.id, grantedAt: inserted.grantedAt } };
  } catch (insertError) {
    // The partial unique index is the authority on "already active", not a read beforehand.
    if (isUniqueViolation(insertError)) {
      return { success: false, error: { type: "ALREADY_GRANTED" } };
    }
    throw insertError;
  }
}

/** Revoke one account's active Premium AI grant. The row stays as history. */
export async function revokeCloudAccess(
  staffUserId: string,
  subjectUserId: string,
): Promise<Result<{ readonly revokedAt: Date }, AssistantCloudAccessAdminError>> {
  const capability = await requirePlatformCapability(staffUserId, "grant_ai_assistant_cloud");
  if (!capability.success) return { success: false, error: CAPABILITY_REQUIRED };

  const [revoked] = await db
    .update(assistantCloudEntitlement)
    .set({ revokedAt: sql`now()`, revokedByUserId: staffUserId })
    .where(
      and(
        eq(assistantCloudEntitlement.userId, subjectUserId),
        isNull(assistantCloudEntitlement.revokedAt),
      ),
    )
    .returning({ revokedAt: assistantCloudEntitlement.revokedAt });
  if (revoked === undefined || revoked.revokedAt === null) {
    return { success: false, error: { type: "NOT_GRANTED" } };
  }
  return { success: true, value: { revokedAt: revoked.revokedAt } };
}
