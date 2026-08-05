import { and, eq, inArray, isNull } from "drizzle-orm";

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
