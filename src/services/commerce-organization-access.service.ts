import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { commerceOrganization, commerceOrganizationMember, session } from "#src/db/schema.js";
import type { Result } from "#src/types/index.js";

export type CommerceOrganizationMemberRole =
  (typeof commerceOrganizationMember.$inferSelect)["role"];

export interface ActiveCommerceOrganizationContext {
  readonly organizationId: string;
  readonly memberId: string;
  readonly memberRole: CommerceOrganizationMemberRole;
  readonly tradeState: "active";
}

export type ActiveCommerceOrganizationAccessError =
  | { type: "ACTIVE_ORGANIZATION_REQUIRED" }
  | { type: "ACTIVE_COMMERCE_ACCESS_REQUIRED" };

export type ActiveSellerCommerceOrganizationAccessError =
  | { type: "ACTIVE_SELLER_ORGANIZATION_REQUIRED" }
  | { type: "ACTIVE_SELLER_MEMBERSHIP_REQUIRED" };

const SELLER_MEMBER_ROLES: readonly CommerceOrganizationMemberRole[] = ["owner", "seller"];

const BUYER_MEMBER_ROLES: readonly CommerceOrganizationMemberRole[] = [
  "owner",
  "administrator",
  "buyer",
];

const PROVIDER_MEMBER_ROLES: readonly CommerceOrganizationMemberRole[] = [
  "owner",
  "administrator",
  "provider_operator",
];

/**
 * The counterparty side of an order — whichever role created the listing or quote the
 * order fulfills. An order's `counterpartyOrganizationId` may be a product seller
 * (direct/cart checkout) or a service provider (accepted quote), so this union covers
 * both rather than forcing fulfillment routes to pick one role family.
 */
const COUNTERPARTY_MEMBER_ROLES: readonly CommerceOrganizationMemberRole[] = [
  "owner",
  "administrator",
  "seller",
  "provider_operator",
];

export function memberCanOperateProvider(memberRole: CommerceOrganizationMemberRole): boolean {
  return PROVIDER_MEMBER_ROLES.includes(memberRole);
}

export function memberCanOperateBuyer(memberRole: CommerceOrganizationMemberRole): boolean {
  return BUYER_MEMBER_ROLES.includes(memberRole);
}

export function memberCanOperateCounterparty(memberRole: CommerceOrganizationMemberRole): boolean {
  return COUNTERPARTY_MEMBER_ROLES.includes(memberRole);
}

export function memberCanUpdateOrganizationVisibility(
  memberRole: CommerceOrganizationMemberRole,
): boolean {
  return memberRole === "owner" || memberRole === "administrator";
}

export type ActiveBuyerCommerceOrganizationAccessError =
  | { type: "ACTIVE_BUYER_ORGANIZATION_REQUIRED" }
  | { type: "ACTIVE_BUYER_MEMBERSHIP_REQUIRED" };

/**
 * The buyer's own organization, whether or not it has been cleared to trade (§14, A37).
 *
 * DELIBERATELY A SEPARATE TYPE FROM {@link ActiveCommerceOrganizationContext} rather than a
 * widening of it. That type's `tradeState: "active"` literal is what makes a pending
 * organization unrepresentable across the thirty-odd handlers that read
 * `req.commerceOrganization`, and relaxing it there would admit a pending shell into every
 * one of them at once — including `checkout/confirm`, which is exactly the gate §14 said
 * must stay. Two types means a handler that reads the wrong one does not compile.
 *
 * §14 admits a `pending` shell to the taps IN FRONT of the trust gates — cart,
 * `checkout/prepare`, RFQ drafting, inquiry, messaging, document upload — and nothing
 * behind them.
 */
export interface ProvisionedBuyerCommerceWorkspaceContext {
  readonly organizationId: string;
  readonly memberId: string;
  readonly memberRole: CommerceOrganizationMemberRole;
  readonly tradeState: "pending" | "active";
}

export type ActiveProviderCommerceOrganizationAccessError =
  | { type: "ACTIVE_PROVIDER_ORGANIZATION_REQUIRED" }
  | { type: "ACTIVE_PROVIDER_MEMBERSHIP_REQUIRED" };

interface SellerCommerceOrganizationRow {
  readonly organizationId: string;
  readonly memberId: string;
  readonly memberRole: CommerceOrganizationMemberRole;
  readonly tradeState: (typeof commerceOrganization.$inferSelect)["tradeState"];
}

/**
 * Resolves session-selected commerce context from current database state.
 *
 * This deliberately performs a fresh indexed join on every invocation. The session
 * selection is only a pointer: membership suspension, departure, and organization
 * trade suspension must take effect on the next protected request.
 */
export async function resolveActiveCommerceOrganization(input: {
  readonly userId: string;
  readonly activeOrganizationId: string | null;
}): Promise<Result<ActiveCommerceOrganizationContext, ActiveCommerceOrganizationAccessError>> {
  if (input.activeOrganizationId === null) {
    return { success: false, error: { type: "ACTIVE_ORGANIZATION_REQUIRED" } };
  }

  const [activeAccess] = await db
    .select({
      organizationId: commerceOrganization.id,
      memberId: commerceOrganizationMember.id,
      memberRole: commerceOrganizationMember.role,
      tradeState: commerceOrganization.tradeState,
    })
    .from(commerceOrganizationMember)
    .innerJoin(
      commerceOrganization,
      eq(commerceOrganization.id, commerceOrganizationMember.organizationId),
    )
    .where(
      and(
        eq(commerceOrganizationMember.userId, input.userId),
        eq(commerceOrganizationMember.organizationId, input.activeOrganizationId),
        eq(commerceOrganizationMember.state, "active"),
        eq(commerceOrganization.tradeState, "active"),
      ),
    )
    .limit(1);

  if (!activeAccess || activeAccess.tradeState !== "active") {
    // Membership and trade failures are intentionally indistinguishable to callers.
    return { success: false, error: { type: "ACTIVE_COMMERCE_ACCESS_REQUIRED" } };
  }

  return {
    success: true,
    value: {
      organizationId: activeAccess.organizationId,
      memberId: activeAccess.memberId,
      memberRole: activeAccess.memberRole,
      tradeState: activeAccess.tradeState,
    },
  };
}

async function findActiveSellerOrganizations(
  userId: string,
  organizationId: string | null,
  limit: number,
): Promise<readonly SellerCommerceOrganizationRow[]> {
  const organizationFilter =
    organizationId === null
      ? and(
          eq(commerceOrganizationMember.userId, userId),
          eq(commerceOrganizationMember.state, "active"),
          inArray(commerceOrganizationMember.role, SELLER_MEMBER_ROLES),
          eq(commerceOrganization.tradeState, "active"),
        )
      : and(
          eq(commerceOrganizationMember.userId, userId),
          eq(commerceOrganizationMember.organizationId, organizationId),
          eq(commerceOrganizationMember.state, "active"),
          inArray(commerceOrganizationMember.role, SELLER_MEMBER_ROLES),
          eq(commerceOrganization.tradeState, "active"),
        );

  return db
    .select({
      organizationId: commerceOrganization.id,
      memberId: commerceOrganizationMember.id,
      memberRole: commerceOrganizationMember.role,
      tradeState: commerceOrganization.tradeState,
    })
    .from(commerceOrganizationMember)
    .innerJoin(
      commerceOrganization,
      eq(commerceOrganization.id, commerceOrganizationMember.organizationId),
    )
    .where(organizationFilter)
    .limit(limit);
}

/**
 * Resolves the organization allowed to own product listings.
 *
 * During the expand rollout, old sessions can have no selected organization. Only
 * that case may auto-select, and only when exactly one active seller/owner
 * organization exists. The selection is derived from memberships, never request data.
 */
export async function resolveActiveSellerCommerceOrganization(input: {
  readonly userId: string;
  readonly sessionId: string;
  readonly activeOrganizationId: string | null;
}): Promise<
  Result<ActiveCommerceOrganizationContext, ActiveSellerCommerceOrganizationAccessError>
> {
  if (input.activeOrganizationId !== null) {
    const [selectedOrganization] = await findActiveSellerOrganizations(
      input.userId,
      input.activeOrganizationId,
      1,
    );
    if (!selectedOrganization || selectedOrganization.tradeState !== "active") {
      return { success: false, error: { type: "ACTIVE_SELLER_MEMBERSHIP_REQUIRED" } };
    }
    return {
      success: true,
      value: {
        organizationId: selectedOrganization.organizationId,
        memberId: selectedOrganization.memberId,
        memberRole: selectedOrganization.memberRole,
        tradeState: selectedOrganization.tradeState,
      },
    };
  }

  const sellerOrganizations = await findActiveSellerOrganizations(input.userId, null, 2);
  if (sellerOrganizations.length !== 1) {
    return { success: false, error: { type: "ACTIVE_SELLER_ORGANIZATION_REQUIRED" } };
  }

  const [soleOrganization] = sellerOrganizations;
  if (!soleOrganization || soleOrganization.tradeState !== "active") {
    return { success: false, error: { type: "ACTIVE_SELLER_ORGANIZATION_REQUIRED" } };
  }

  const [selectedSession] = await db
    .update(session)
    .set({ activeOrganizationId: soleOrganization.organizationId, updatedAt: new Date() })
    .where(
      and(
        eq(session.id, input.sessionId),
        eq(session.userId, input.userId),
        isNull(session.activeOrganizationId),
      ),
    )
    .returning({ id: session.id });

  if (!selectedSession) {
    // A concurrent explicit switch won the compare-and-set. This request must not
    // continue under the stale auto-selected tenant; the next request will resolve
    // the newly persisted context.
    return { success: false, error: { type: "ACTIVE_SELLER_ORGANIZATION_REQUIRED" } };
  }

  return {
    success: true,
    value: {
      organizationId: soleOrganization.organizationId,
      memberId: soleOrganization.memberId,
      memberRole: soleOrganization.memberRole,
      tradeState: soleOrganization.tradeState,
    },
  };
}

async function findActiveOrganizationsForRoles(
  userId: string,
  organizationId: string | null,
  allowedRoles: readonly CommerceOrganizationMemberRole[],
  limit: number,
): Promise<readonly SellerCommerceOrganizationRow[]> {
  const organizationFilter =
    organizationId === null
      ? and(
          eq(commerceOrganizationMember.userId, userId),
          eq(commerceOrganizationMember.state, "active"),
          inArray(commerceOrganizationMember.role, [...allowedRoles]),
          eq(commerceOrganization.tradeState, "active"),
        )
      : and(
          eq(commerceOrganizationMember.userId, userId),
          eq(commerceOrganizationMember.organizationId, organizationId),
          eq(commerceOrganizationMember.state, "active"),
          inArray(commerceOrganizationMember.role, [...allowedRoles]),
          eq(commerceOrganization.tradeState, "active"),
        );

  return db
    .select({
      organizationId: commerceOrganization.id,
      memberId: commerceOrganizationMember.id,
      memberRole: commerceOrganizationMember.role,
      tradeState: commerceOrganization.tradeState,
    })
    .from(commerceOrganizationMember)
    .innerJoin(
      commerceOrganization,
      eq(commerceOrganization.id, commerceOrganizationMember.organizationId),
    )
    .where(organizationFilter)
    .limit(limit);
}

/**
 * Resolves the active organization allowed to create and manage RFQs as a buyer.
 * Organization id comes from the session pointer only; membership is re-proven.
 */
export async function resolveActiveBuyerCommerceOrganization(input: {
  readonly userId: string;
  readonly activeOrganizationId: string | null;
}): Promise<Result<ActiveCommerceOrganizationContext, ActiveBuyerCommerceOrganizationAccessError>> {
  if (input.activeOrganizationId === null) {
    return { success: false, error: { type: "ACTIVE_BUYER_ORGANIZATION_REQUIRED" } };
  }

  const [selectedOrganization] = await findActiveOrganizationsForRoles(
    input.userId,
    input.activeOrganizationId,
    BUYER_MEMBER_ROLES,
    1,
  );
  if (!selectedOrganization || selectedOrganization.tradeState !== "active") {
    return { success: false, error: { type: "ACTIVE_BUYER_MEMBERSHIP_REQUIRED" } };
  }

  return {
    success: true,
    value: {
      organizationId: selectedOrganization.organizationId,
      memberId: selectedOrganization.memberId,
      memberRole: selectedOrganization.memberRole,
      tradeState: selectedOrganization.tradeState,
    },
  };
}

/**
 * The trade states a buyer workspace may occupy — everything except the two that are a
 * withdrawal of trust rather than an absence of it.
 *
 * `suspended` and `closed` are excluded on purpose. A shell that has never been reviewed is
 * not the same thing as one a moderator shut down, and auto-provisioning must not hand a
 * suspended organization back its cart.
 */
const BUYER_WORKSPACE_TRADE_STATES = ["pending", "active"] as const;

/**
 * Finds the caller's buyer-capable memberships, admitting a `pending` organization.
 *
 * Pass `organizationId` to re-prove the session's pointer, or `null` to discover whether the
 * caller has any workspace at all — which is the question auto-provisioning asks before it
 * mints one.
 */
export async function findBuyerCommerceWorkspaces(
  userId: string,
  organizationId: string | null,
  limit: number,
): Promise<readonly ProvisionedBuyerCommerceWorkspaceContext[]> {
  const workspaceFilter =
    organizationId === null
      ? and(
          eq(commerceOrganizationMember.userId, userId),
          eq(commerceOrganizationMember.state, "active"),
          inArray(commerceOrganizationMember.role, [...BUYER_MEMBER_ROLES]),
          inArray(commerceOrganization.tradeState, [...BUYER_WORKSPACE_TRADE_STATES]),
        )
      : and(
          eq(commerceOrganizationMember.userId, userId),
          eq(commerceOrganizationMember.organizationId, organizationId),
          eq(commerceOrganizationMember.state, "active"),
          inArray(commerceOrganizationMember.role, [...BUYER_MEMBER_ROLES]),
          inArray(commerceOrganization.tradeState, [...BUYER_WORKSPACE_TRADE_STATES]),
        );

  const rows = await db
    .select({
      organizationId: commerceOrganization.id,
      memberId: commerceOrganizationMember.id,
      memberRole: commerceOrganizationMember.role,
      tradeState: commerceOrganization.tradeState,
    })
    .from(commerceOrganizationMember)
    .innerJoin(
      commerceOrganization,
      eq(commerceOrganization.id, commerceOrganizationMember.organizationId),
    )
    .where(workspaceFilter)
    // Oldest first, so a caller who somehow holds two workspaces keeps landing in the same
    // one rather than alternating between carts.
    .orderBy(asc(commerceOrganization.createdAt), asc(commerceOrganization.id))
    .limit(limit);

  // The SQL already excludes `suspended` and `closed`; this narrows the type to match, and
  // fails loudly rather than silently dropping a row if the two ever diverge.
  return rows.map((row) => {
    if (row.tradeState !== "pending" && row.tradeState !== "active") {
      throw new Error(
        `Buyer workspace query returned trade state ${row.tradeState}, which its own filter excludes.`,
      );
    }
    return {
      organizationId: row.organizationId,
      memberId: row.memberId,
      memberRole: row.memberRole,
      tradeState: row.tradeState,
    };
  });
}

/**
 * Resolves the active organization allowed to operate provider quote workflows.
 */
export async function resolveActiveProviderCommerceOrganization(input: {
  readonly userId: string;
  readonly activeOrganizationId: string | null;
}): Promise<
  Result<ActiveCommerceOrganizationContext, ActiveProviderCommerceOrganizationAccessError>
> {
  if (input.activeOrganizationId === null) {
    return { success: false, error: { type: "ACTIVE_PROVIDER_ORGANIZATION_REQUIRED" } };
  }

  const [selectedOrganization] = await findActiveOrganizationsForRoles(
    input.userId,
    input.activeOrganizationId,
    PROVIDER_MEMBER_ROLES,
    1,
  );
  if (!selectedOrganization || selectedOrganization.tradeState !== "active") {
    return { success: false, error: { type: "ACTIVE_PROVIDER_MEMBERSHIP_REQUIRED" } };
  }

  return {
    success: true,
    value: {
      organizationId: selectedOrganization.organizationId,
      memberId: selectedOrganization.memberId,
      memberRole: selectedOrganization.memberRole,
      tradeState: selectedOrganization.tradeState,
    },
  };
}
