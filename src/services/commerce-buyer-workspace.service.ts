import { randomBytes } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { commerceOrganization, commerceOrganizationMember, session, user } from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import {
  findBuyerCommerceWorkspaces,
  type ProvisionedBuyerCommerceWorkspaceContext,
} from "#src/modules/store/organizations/commerce-organization-access.service.js";
import { appendCommerceOrganizationAuditEntry } from "#src/modules/store/organizations/commerce-organization-audit.service.js";
import { normalizeLegalName } from "#src/modules/store/organizations/commerce-organizations.service.js";
import type { Result } from "#src/types/index.js";

export type BuyerCommerceWorkspaceError =
  /**
   * The session pointer names an organization the caller cannot operate as a buyer — a
   * membership that was suspended or a role that was demoted between requests. NOT a
   * provisioning trigger: the caller HAS a workspace selected and lost access to it, and
   * minting a second one behind their back would silently move their cart.
   */
  | { type: "BUYER_WORKSPACE_ACCESS_LOST" }
  /** The account row vanished mid-request. Unrecoverable rather than operational. */
  | { type: "ACCOUNT_NOT_FOUND" };

/** `^[a-z0-9]+(-[a-z0-9]+)*$`, 3–100 chars — `commerce_organization_slug_ck`. */
function mintWorkspaceSlug(): string {
  return `buyer-${randomBytes(6).toString("hex")}`;
}

/**
 * `commerce_organization_name_ck` caps legal and display names at 200 characters.
 *
 * A shell borrows the account holder's name because that is the only true thing the server
 * knows about who is buying. It is not a company name and is not treated as one — the row
 * carries `provisioningOrigin = 'auto_provisioned'` precisely so nothing reads it as an
 * assertion about a business.
 */
function clampOrganizationName(accountName: string): string {
  const collapsed = accountName.normalize("NFKC").trim().replace(/\s+/g, " ");
  const clamped = collapsed.slice(0, 200);
  // The CHECK also demands at least one character, and `user.name` is NOT NULL but not
  // non-empty. A blank display name would render as a nameless counterparty in a thread.
  return clamped.length > 0 ? clamped : "Buyer";
}

/**
 * Points the session at a workspace, but only if it is not already pointing somewhere.
 *
 * The `IS NULL` guard makes this a compare-and-set. A concurrent explicit organization
 * switch must win, because continuing this request under a tenant the user has just
 * navigated away from would write a cart line into the wrong organization. This mirrors
 * `resolveActiveSellerCommerceOrganization`'s auto-selection, including its conclusion that
 * a lost CAS fails the request rather than proceeding.
 */
async function selectWorkspaceForSession(input: {
  readonly sessionId: string;
  readonly userId: string;
  readonly organizationId: string;
}): Promise<boolean> {
  const [selectedSession] = await db
    .update(session)
    .set({ activeOrganizationId: input.organizationId, updatedAt: new Date() })
    .where(
      and(
        eq(session.id, input.sessionId),
        eq(session.userId, input.userId),
        isNull(session.activeOrganizationId),
      ),
    )
    .returning({ id: session.id });
  return selectedSession !== undefined;
}

async function mintBuyerWorkspace(
  userId: string,
): Promise<Result<ProvisionedBuyerCommerceWorkspaceContext, BuyerCommerceWorkspaceError>> {
  const [accountRow] = await db
    .select({ name: user.name })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!accountRow) return { success: false, error: { type: "ACCOUNT_NOT_FOUND" } };

  const organizationName = clampOrganizationName(accountRow.name);

  const minted = await db.transaction(async (transaction) => {
    const occurredAt = new Date();
    const [organization] = await transaction
      .insert(commerceOrganization)
      .values({
        slug: mintWorkspaceSlug(),
        legalName: organizationName,
        normalizedLegalName: normalizeLegalName(organizationName),
        displayName: organizationName,
        summary: null,
        // The honest default for an individual who has declared nothing. A shell is not a
        // `company` until somebody says it is, and that saying is what flips
        // `provisioningOrigin`.
        organizationType: "sole_proprietor",
        // NULL by design — see `commerce_organization_country_pending_ck`. The server has no
        // verified country at this point and §0 forbids inventing one.
        countryCode: null,
        tradeState: "pending",
        visibility: "private",
        provisioningOrigin: "auto_provisioned",
        createdByUserId: userId,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      })
      .returning();
    if (!organization) throw new Error("Buyer workspace insert returned no row.");

    const [ownerMembership] = await transaction
      .insert(commerceOrganizationMember)
      .values({
        organizationId: organization.id,
        userId,
        role: "owner",
        state: "active",
        joinedAt: occurredAt,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      })
      .returning({ id: commerceOrganizationMember.id, role: commerceOrganizationMember.role });
    if (!ownerMembership) throw new Error("Buyer workspace owner membership returned no row.");

    const appended = await appendCommerceOrganizationAuditEntry(transaction, {
      organizationId: organization.id,
      eventKind: "organization_created",
      actorUserId: userId,
      actorMemberRoleSnapshot: "owner",
      targetEntityType: "commerce_organization",
      targetEntityId: organization.id,
      payload: {
        tradeState: "pending",
        visibility: "private",
        provisioningOrigin: "auto_provisioned",
        ownerMemberId: ownerMembership.id,
      },
      occurredAt,
    });
    if (!appended.success) {
      throw new Error(`Buyer workspace audit append failed: ${appended.error.type}`);
    }

    return {
      organizationId: organization.id,
      memberId: ownerMembership.id,
      memberRole: ownerMembership.role,
      tradeState: "pending",
    } as const satisfies ProvisionedBuyerCommerceWorkspaceContext;
  });

  return { success: true, value: minted };
}

/**
 * Two different unique indexes can refuse this INSERT, and they mean opposite things.
 *
 * `commerce_organization_auto_provisioned_owner_uidx` means a CONCURRENT FIRST TAP already
 * minted this user's shell. That is expected traffic on a double-submit, and the right
 * answer is the winner's row so both requests land in one cart.
 *
 * `commerce_organization_slug_uidx` means two shells drew the same 48 bits. Vanishingly
 * rare, but re-reading would find nothing and rethrowing would 500 a request that only
 * needed a different slug.
 *
 * Postgres gives the SQLSTATE and not the constraint name through this driver path, so the
 * two are told apart by consequence rather than by label: if a workspace now exists, the
 * owner index fired; if none does, the slug did and a fresh draw is worth trying.
 */
async function mintBuyerWorkspaceHandlingCollisions(
  userId: string,
): Promise<Result<ProvisionedBuyerCommerceWorkspaceContext, BuyerCommerceWorkspaceError>> {
  const MAXIMUM_SLUG_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAXIMUM_SLUG_ATTEMPTS; attempt += 1) {
    try {
      return await mintBuyerWorkspace(userId);
    } catch (mintError: unknown) {
      if (!isUniqueViolation(mintError)) throw mintError;

      const [concurrentWorkspace] = await findBuyerCommerceWorkspaces(userId, null, 1);
      if (concurrentWorkspace) return { success: true, value: concurrentWorkspace };

      if (attempt === MAXIMUM_SLUG_ATTEMPTS) throw mintError;
    }
  }

  // Unreachable: the loop either returns or throws on its final attempt. Stated rather than
  // left to a fallthrough so a future edit to the bounds cannot return undefined silently.
  throw new Error("Buyer workspace minting exhausted its attempts without returning.");
}

/**
 * Resolves the caller's buyer workspace, creating one on first use (§14, Appendix A37).
 *
 * §14 marked this DECIDED and it was never built, so until Phase 21 a signed-in buyer's
 * first cart tap answered 403 and stayed 403 until staff activated an organization by hand.
 * The shell this mints is `pending` and stays `pending`: it unblocks the taps in front of
 * the trust gates and moves none of them.
 *
 * THE ORDER OF THE THREE BRANCHES IS THE WHOLE DESIGN.
 *
 * 1. A session pointer is re-proven, never trusted. If it names an organization the caller
 *    can still operate as a buyer, that is the answer and nothing is created.
 * 2. A pointer that no longer resolves is an ACCESS LOSS, not a provisioning trigger. The
 *    caller had a workspace and lost their seat in it; minting a fresh one would silently
 *    hand them an empty cart and hide the demotion.
 * 3. Only a caller with NO pointer and NO buyer-capable membership anywhere gets a new
 *    shell. A seller who taps the cart therefore lands in the organization they already
 *    own rather than accumulating a second one.
 */
export async function provisionBuyerCommerceWorkspace(input: {
  readonly userId: string;
  readonly sessionId: string;
  readonly activeOrganizationId: string | null;
}): Promise<Result<ProvisionedBuyerCommerceWorkspaceContext, BuyerCommerceWorkspaceError>> {
  if (input.activeOrganizationId !== null) {
    const [selectedWorkspace] = await findBuyerCommerceWorkspaces(
      input.userId,
      input.activeOrganizationId,
      1,
    );
    if (!selectedWorkspace)
      return { success: false, error: { type: "BUYER_WORKSPACE_ACCESS_LOST" } };
    return { success: true, value: selectedWorkspace };
  }

  const [existingWorkspace] = await findBuyerCommerceWorkspaces(input.userId, null, 1);
  if (existingWorkspace) {
    const selected = await selectWorkspaceForSession({
      sessionId: input.sessionId,
      userId: input.userId,
      organizationId: existingWorkspace.organizationId,
    });
    if (!selected) return { success: false, error: { type: "BUYER_WORKSPACE_ACCESS_LOST" } };
    return { success: true, value: existingWorkspace };
  }

  const mintResult = await mintBuyerWorkspaceHandlingCollisions(input.userId);
  if (!mintResult.success) return mintResult;

  const selected = await selectWorkspaceForSession({
    sessionId: input.sessionId,
    userId: input.userId,
    organizationId: mintResult.value.organizationId,
  });
  if (!selected) return { success: false, error: { type: "BUYER_WORKSPACE_ACCESS_LOST" } };

  return mintResult;
}
