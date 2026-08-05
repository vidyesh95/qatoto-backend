import { randomUUID } from "node:crypto";

import { and, asc, eq, ne } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceEncryptedDocument,
  commerceOrganization,
  commerceOrganizationAddress,
  commerceOrganizationMember,
  commerceOrganizationVerification,
  session,
  user,
} from "#src/db/schema.js";
import {
  decryptCommerceDocument,
  encryptCommerceDocument,
} from "#src/lib/commerce-document-encryption.js";
import { decryptCommercePii, encryptCommercePii } from "#src/lib/commerce-pii-encryption.js";
import {
  deletePrivateCommerceDocument,
  downloadPrivateCommerceDocument,
  uploadPrivateCommerceDocument,
} from "#src/lib/object-storage.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { appendCommerceOrganizationAuditEntry } from "#src/services/commerce-organization-audit.service.js";
import { requirePlatformCapability } from "#src/services/platform-role.service.js";
import type { Result } from "#src/types/index.js";

type Organization = typeof commerceOrganization.$inferSelect;
type Member = typeof commerceOrganizationMember.$inferSelect;
type Address = typeof commerceOrganizationAddress.$inferSelect;
type Verification = typeof commerceOrganizationVerification.$inferSelect;
type MemberRole = Member["role"];
type MemberState = Member["state"];
type AddressKind = Address["addressKind"];
type OrganizationType = Organization["organizationType"];
type VerificationKind = Verification["verificationKind"];
type DocumentKind = typeof commerceEncryptedDocument.$inferSelect.documentKind;
type DocumentState = typeof commerceEncryptedDocument.$inferSelect.state;
type VerificationState = Verification["state"];
type ScannerVerdictOutcome =
  | { readonly status: "recorded"; readonly documentId: string; readonly state: DocumentState }
  | { readonly status: "not_pending" }
  | { readonly status: "self_review_forbidden" };
type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type CommerceOrganizationsError =
  | { type: "NOT_FOUND" }
  | { type: "FORBIDDEN" }
  | { type: "CONFLICT"; message: string }
  | { type: "LAST_OWNER_REQUIRED" }
  | { type: "ROLE_ESCALATION_FORBIDDEN" }
  | { type: "PII_ENCRYPTION_UNAVAILABLE" }
  | { type: "STORAGE_NOT_CONFIGURED" }
  | { type: "STORAGE_FAILED" }
  | {
      type: "STORAGE_CLEANUP_FAILED";
      originalFailure: "CONFLICT" | "DATABASE_FAILURE";
    }
  | { type: "PLATFORM_CAPABILITY_REQUIRED" }
  | { type: "SELF_REVIEW_FORBIDDEN" };

export interface CreateOrganizationInput {
  readonly slug: string;
  readonly legalName: string;
  readonly displayName: string;
  readonly summary?: string;
  readonly organizationType: OrganizationType;
  readonly countryCode: string;
  readonly registrationNumber?: string;
  readonly taxIdentifier?: string;
  readonly websiteUrl?: string;
}

export interface UpdateOrganizationInput {
  readonly displayName?: string;
  readonly summary?: string | null;
  readonly websiteUrl?: string | null;
  readonly logoUrl?: string | null;
  readonly visibility?: "private" | "public";
}

export interface CreateMemberInput {
  readonly userId: string;
  readonly role: Exclude<MemberRole, "owner">;
}

export interface UpdateMemberInput {
  readonly role?: Exclude<MemberRole, "owner">;
  readonly state?: Exclude<MemberState, "invited">;
}

export interface AddressInput {
  readonly addressKind: AddressKind;
  readonly label?: string | null;
  readonly countryCode: string;
  readonly regionCode?: string | null;
  readonly locality: string;
  readonly postalCode?: string | null;
  readonly recipientName?: string | null;
  readonly addressLineOne: string;
  readonly addressLineTwo?: string | null;
  readonly phone?: string | null;
  readonly isDefault: boolean;
}

export type UpdateAddressInput = Partial<AddressInput>;

interface MembershipContext {
  readonly memberId: string;
  readonly role: MemberRole;
}

type MemberUpdateOutcome =
  | { readonly status: "updated"; readonly member: Member }
  | { readonly status: "not_found" }
  | { readonly status: "forbidden" }
  | { readonly status: "invalid_transition" }
  | { readonly status: "race_conflict" };

type VerificationDecisionOutcome =
  | { readonly status: "decided"; readonly verification: Verification }
  | { readonly status: "not_found" }
  | { readonly status: "self_review" }
  | { readonly status: "conflict" };

const ORGANIZATION_MANAGERS: readonly MemberRole[] = ["owner", "administrator"];
const ADDRESS_MANAGERS: readonly MemberRole[] = ["owner", "administrator", "finance"];
const VERIFICATION_MANAGERS: readonly MemberRole[] = ["owner", "administrator"];
const VERIFICATION_READERS: readonly MemberRole[] = ["owner", "administrator", "finance"];

const LEGAL_MEMBER_STATE_TRANSITIONS: Readonly<Record<MemberState, readonly MemberState[]>> = {
  invited: ["active"],
  active: ["suspended", "left"],
  suspended: ["active", "left"],
  left: [],
};

function normalizeLegalName(legalName: string): string {
  return legalName.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function publicOrganization(organization: Organization) {
  return {
    id: organization.id,
    slug: organization.slug,
    legalName: organization.legalName,
    displayName: organization.displayName,
    summary: organization.summary,
    organizationType: organization.organizationType,
    tradeState: organization.tradeState,
    visibility: organization.visibility,
    countryCode: organization.countryCode,
    logoUrl: organization.logoUrl,
    websiteUrl: organization.websiteUrl,
    createdAt: organization.createdAt,
    updatedAt: organization.updatedAt,
  };
}

async function activeMembership(
  userId: string,
  organizationId: string,
): Promise<MembershipContext | null> {
  const [membership] = await db
    .select({ memberId: commerceOrganizationMember.id, role: commerceOrganizationMember.role })
    .from(commerceOrganizationMember)
    .where(
      and(
        eq(commerceOrganizationMember.organizationId, organizationId),
        eq(commerceOrganizationMember.userId, userId),
        eq(commerceOrganizationMember.state, "active"),
      ),
    )
    .limit(1);
  return membership ?? null;
}

async function requireMembershipRole(
  userId: string,
  organizationId: string,
  allowedRoles: readonly MemberRole[],
): Promise<Result<MembershipContext, CommerceOrganizationsError>> {
  const membership = await activeMembership(userId, organizationId);
  if (!membership || !allowedRoles.includes(membership.role)) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }
  return { success: true, value: membership };
}

async function appendAuditOrThrow(
  transaction: DatabaseTransaction,
  input: Parameters<typeof appendCommerceOrganizationAuditEntry>[1],
): Promise<void> {
  const appended = await appendCommerceOrganizationAuditEntry(transaction, input);
  if (!appended.success) {
    throw new Error(`Organization audit append failed: ${appended.error.type}`);
  }
}

function encryptOptionalPii(
  plaintext: string | null | undefined,
): Result<string | null, CommerceOrganizationsError> {
  if (plaintext === null || plaintext === undefined) return { success: true, value: null };
  const encrypted = encryptCommercePii(plaintext);
  if (!encrypted.success) {
    return { success: false, error: { type: "PII_ENCRYPTION_UNAVAILABLE" } };
  }
  return { success: true, value: encrypted.value };
}

function decryptOptionalPii(ciphertext: string | null): string | null {
  if (ciphertext === null) return null;
  const decrypted = decryptCommercePii(ciphertext);
  if (!decrypted.success)
    throw new Error(`Stored commerce PII cannot be decrypted: ${decrypted.error.type}`);
  return decrypted.value;
}

export async function createOrganization(
  userId: string,
  input: CreateOrganizationInput,
): Promise<Result<ReturnType<typeof publicOrganization>, CommerceOrganizationsError>> {
  const registrationNumber = encryptOptionalPii(input.registrationNumber);
  if (!registrationNumber.success) return registrationNumber;
  const taxIdentifier = encryptOptionalPii(input.taxIdentifier);
  if (!taxIdentifier.success) return taxIdentifier;

  try {
    const created = await db.transaction(async (transaction) => {
      const occurredAt = new Date();
      const [organization] = await transaction
        .insert(commerceOrganization)
        .values({
          slug: input.slug,
          legalName: input.legalName,
          normalizedLegalName: normalizeLegalName(input.legalName),
          displayName: input.displayName,
          summary: input.summary,
          organizationType: input.organizationType,
          countryCode: input.countryCode,
          registrationNumberEncrypted: registrationNumber.value,
          taxIdentifierEncrypted: taxIdentifier.value,
          websiteUrl: input.websiteUrl,
          tradeState: "pending",
          visibility: "private",
          createdByUserId: userId,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        })
        .returning();
      if (!organization) throw new Error("Organization insert returned no row.");

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
        .returning({ id: commerceOrganizationMember.id });
      if (!ownerMembership) throw new Error("Owner membership insert returned no row.");

      await appendAuditOrThrow(transaction, {
        organizationId: organization.id,
        eventKind: "organization_created",
        actorUserId: userId,
        actorMemberRoleSnapshot: "owner",
        targetEntityType: "commerce_organization",
        targetEntityId: organization.id,
        payload: {
          tradeState: "pending",
          visibility: "private",
          ownerMemberId: ownerMembership.id,
        },
        occurredAt,
      });
      return publicOrganization(organization);
    });
    return { success: true, value: created };
  } catch (creationError: unknown) {
    if (isUniqueViolation(creationError)) {
      return {
        success: false,
        error: { type: "CONFLICT", message: "Organization slug is already in use." },
      };
    }
    throw creationError;
  }
}

export async function listMyOrganizations(userId: string): Promise<
  Result<
    readonly {
      readonly organization: ReturnType<typeof publicOrganization>;
      readonly membership: {
        readonly id: string;
        readonly role: MemberRole;
        readonly state: MemberState;
      };
    }[],
    CommerceOrganizationsError
  >
> {
  const rows = await db
    .select({ organization: commerceOrganization, membership: commerceOrganizationMember })
    .from(commerceOrganizationMember)
    .innerJoin(
      commerceOrganization,
      eq(commerceOrganization.id, commerceOrganizationMember.organizationId),
    )
    .where(
      and(
        eq(commerceOrganizationMember.userId, userId),
        eq(commerceOrganizationMember.state, "active"),
      ),
    )
    .orderBy(asc(commerceOrganization.displayName), asc(commerceOrganization.id));
  return {
    success: true,
    value: rows.map((row) => ({
      organization: publicOrganization(row.organization),
      membership: {
        id: row.membership.id,
        role: row.membership.role,
        state: row.membership.state,
      },
    })),
  };
}

export async function activateOrganization(input: {
  readonly userId: string;
  readonly sessionId: string;
  readonly organizationId: string;
}): Promise<Result<{ readonly activeOrganizationId: string }, CommerceOrganizationsError>> {
  const switched = await db.transaction(async (transaction) => {
    const [membership] = await transaction
      .select({
        memberId: commerceOrganizationMember.id,
        role: commerceOrganizationMember.role,
      })
      .from(commerceOrganizationMember)
      .where(
        and(
          eq(commerceOrganizationMember.userId, input.userId),
          eq(commerceOrganizationMember.organizationId, input.organizationId),
          eq(commerceOrganizationMember.state, "active"),
        ),
      )
      .limit(1);
    if (!membership) return false;

    const occurredAt = new Date();
    const [updatedSession] = await transaction
      .update(session)
      .set({ activeOrganizationId: input.organizationId, updatedAt: occurredAt })
      .where(and(eq(session.id, input.sessionId), eq(session.userId, input.userId)))
      .returning({ id: session.id });
    if (!updatedSession) return false;

    await appendAuditOrThrow(transaction, {
      organizationId: input.organizationId,
      eventKind: "organization_updated",
      actorUserId: input.userId,
      actorMemberRoleSnapshot: membership.role,
      targetEntityType: "session_context",
      targetEntityId: updatedSession.id,
      payload: { contextSelected: true },
      occurredAt,
    });
    return true;
  });
  if (!switched) return { success: false, error: { type: "NOT_FOUND" } };
  return { success: true, value: { activeOrganizationId: input.organizationId } };
}

export async function updateOrganization(
  userId: string,
  organizationId: string,
  patch: UpdateOrganizationInput,
): Promise<Result<ReturnType<typeof publicOrganization>, CommerceOrganizationsError>> {
  const access = await requireMembershipRole(userId, organizationId, ORGANIZATION_MANAGERS);
  if (!access.success) return access;

  if (patch.visibility === "public") {
    const [organizationRow] = await db
      .select({ tradeState: commerceOrganization.tradeState })
      .from(commerceOrganization)
      .where(eq(commerceOrganization.id, organizationId))
      .limit(1);
    if (!organizationRow) {
      return { success: false, error: { type: "NOT_FOUND" } };
    }
    if (organizationRow.tradeState !== "active") {
      return {
        success: false,
        error: {
          type: "CONFLICT",
          message: "Only organizations with active trade state may become public.",
        },
      };
    }
  }

  const updated = await db.transaction(async (transaction) => {
    const occurredAt = new Date();
    const [organization] = await transaction
      .update(commerceOrganization)
      .set({ ...patch, updatedAt: occurredAt })
      .where(eq(commerceOrganization.id, organizationId))
      .returning();
    if (!organization) return null;
    await appendAuditOrThrow(transaction, {
      organizationId,
      eventKind: patch.visibility === undefined ? "organization_updated" : "visibility_changed",
      actorUserId: userId,
      actorMemberRoleSnapshot: access.value.role,
      targetEntityType: "commerce_organization",
      targetEntityId: organizationId,
      payload: { changedFields: Object.keys(patch).toSorted() },
      occurredAt,
    });
    return publicOrganization(organization);
  });
  if (!updated) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }
  if (patch.visibility !== undefined) {
    const { refreshOrganizationSearchEligibility } = await import(
      "#src/services/store-search.service.js"
    );
    await refreshOrganizationSearchEligibility(organizationId);
  }
  return { success: true, value: updated };
}

export async function createMember(
  userId: string,
  organizationId: string,
  input: CreateMemberInput,
): Promise<Result<Member, CommerceOrganizationsError>> {
  const access = await requireMembershipRole(userId, organizationId, ORGANIZATION_MANAGERS);
  if (!access.success) return access;
  if (input.role === "administrator" && access.value.role !== "owner") {
    return { success: false, error: { type: "ROLE_ESCALATION_FORBIDDEN" } };
  }

  const [targetUser] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, input.userId))
    .limit(1);
  if (!targetUser) return { success: false, error: { type: "NOT_FOUND" } };
  try {
    const member = await db.transaction(async (transaction) => {
      const occurredAt = new Date();
      const [createdMember] = await transaction
        .insert(commerceOrganizationMember)
        .values({
          organizationId,
          userId: input.userId,
          role: input.role,
          state: "invited",
          invitedByUserId: userId,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        })
        .returning();
      if (!createdMember) throw new Error("Member insert returned no row.");
      await appendAuditOrThrow(transaction, {
        organizationId,
        eventKind: "member_invited",
        actorUserId: userId,
        actorMemberRoleSnapshot: access.value.role,
        targetEntityType: "commerce_organization_member",
        targetEntityId: createdMember.id,
        payload: { assignedRole: input.role },
        occurredAt,
      });
      return createdMember;
    });
    return { success: true, value: member };
  } catch (invitationError: unknown) {
    if (isUniqueViolation(invitationError)) {
      return {
        success: false,
        error: { type: "CONFLICT", message: "User already has a current membership." },
      };
    }
    throw invitationError;
  }
}

export async function updateMember(
  userId: string,
  organizationId: string,
  memberId: string,
  patch: UpdateMemberInput,
): Promise<Result<Member, CommerceOrganizationsError>> {
  const access = await requireMembershipRole(userId, organizationId, ORGANIZATION_MANAGERS);
  if (!access.success) return access;
  if (patch.role !== undefined && patch.state !== undefined) {
    return {
      success: false,
      error: {
        type: "CONFLICT",
        message: "Change a member role and state in separate requests.",
      },
    };
  }
  const outcome = await db.transaction(async (transaction): Promise<MemberUpdateOutcome> => {
    const [target] = await transaction
      .select()
      .from(commerceOrganizationMember)
      .where(
        and(
          eq(commerceOrganizationMember.id, memberId),
          eq(commerceOrganizationMember.organizationId, organizationId),
        ),
      )
      .for("update");
    if (!target) return { status: "not_found" };
    if (
      target.role === "owner" ||
      (patch.role === "administrator" && access.value.role !== "owner")
    ) {
      return { status: "forbidden" };
    }
    if (
      patch.state !== undefined &&
      !LEGAL_MEMBER_STATE_TRANSITIONS[target.state].includes(patch.state)
    ) {
      return { status: "invalid_transition" };
    }

    const occurredAt = new Date();
    const nextState = patch.state;
    const [member] = await transaction
      .update(commerceOrganizationMember)
      .set({
        role: patch.role,
        state: nextState,
        joinedAt: nextState === "active" && target.joinedAt === null ? occurredAt : undefined,
        leftAt: nextState === "left" ? occurredAt : nextState ? null : undefined,
        updatedAt: occurredAt,
      })
      .where(
        and(
          eq(commerceOrganizationMember.id, memberId),
          eq(commerceOrganizationMember.organizationId, organizationId),
          eq(commerceOrganizationMember.state, target.state),
        ),
      )
      .returning();
    if (!member) return { status: "race_conflict" };
    await appendAuditOrThrow(transaction, {
      organizationId,
      eventKind: patch.role === undefined ? "member_state_changed" : "member_role_changed",
      actorUserId: userId,
      actorMemberRoleSnapshot: access.value.role,
      targetEntityType: "commerce_organization_member",
      targetEntityId: memberId,
      payload: { changedFields: Object.keys(patch).toSorted() },
      occurredAt,
    });
    return { status: "updated", member };
  });
  switch (outcome.status) {
    case "updated":
      return { success: true, value: outcome.member };
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "forbidden":
      return { success: false, error: { type: "ROLE_ESCALATION_FORBIDDEN" } };
    case "invalid_transition":
      return {
        success: false,
        error: { type: "CONFLICT", message: "Membership state transition is not permitted." },
      };
    case "race_conflict":
      return {
        success: false,
        error: { type: "CONFLICT", message: "Membership changed concurrently." },
      };
    default: {
      const exhaustiveOutcome: never = outcome;
      throw new Error(`Unhandled member update outcome: ${JSON.stringify(exhaustiveOutcome)}`);
    }
  }
}

interface EncryptedAddressFields {
  readonly recipientNameEncrypted: string | null;
  readonly addressLineOneEncrypted: string | undefined;
  readonly addressLineTwoEncrypted: string | null;
  readonly phoneEncrypted: string | null;
}

function encryptAddress(
  input: AddressInput | UpdateAddressInput,
): Result<EncryptedAddressFields, CommerceOrganizationsError> {
  const recipientName = encryptOptionalPii(input.recipientName);
  if (!recipientName.success) return recipientName;
  let addressLineOneEncrypted: string | undefined;
  if (input.addressLineOne !== undefined) {
    const addressLineOne = encryptCommercePii(input.addressLineOne);
    if (!addressLineOne.success) {
      return { success: false, error: { type: "PII_ENCRYPTION_UNAVAILABLE" } };
    }
    addressLineOneEncrypted = addressLineOne.value;
  }
  const addressLineTwo = encryptOptionalPii(input.addressLineTwo);
  if (!addressLineTwo.success) return addressLineTwo;
  const phone = encryptOptionalPii(input.phone);
  if (!phone.success) return phone;
  return {
    success: true,
    value: {
      recipientNameEncrypted: recipientName.value,
      addressLineOneEncrypted,
      addressLineTwoEncrypted: addressLineTwo.value,
      phoneEncrypted: phone.value,
    },
  };
}

function readableAddress(address: Address) {
  return {
    id: address.id,
    organizationId: address.organizationId,
    addressKind: address.addressKind,
    label: address.label,
    countryCode: address.countryCode,
    regionCode: address.regionCode,
    locality: address.locality,
    postalCode: address.postalCode,
    recipientName: decryptOptionalPii(address.recipientNameEncrypted),
    addressLineOne: decryptOptionalPii(address.addressLineOneEncrypted),
    addressLineTwo: decryptOptionalPii(address.addressLineTwoEncrypted),
    phone: decryptOptionalPii(address.phoneEncrypted),
    isDefault: address.isDefault,
    createdAt: address.createdAt,
    updatedAt: address.updatedAt,
  };
}

export async function listAddresses(
  userId: string,
  organizationId: string,
): Promise<Result<readonly ReturnType<typeof readableAddress>[], CommerceOrganizationsError>> {
  const access = await requireMembershipRole(userId, organizationId, [
    ...ADDRESS_MANAGERS,
    "buyer",
    "seller",
    "provider_operator",
    "support",
    "viewer",
  ]);
  if (!access.success) return access;
  const addresses = await db
    .select()
    .from(commerceOrganizationAddress)
    .where(eq(commerceOrganizationAddress.organizationId, organizationId))
    .orderBy(asc(commerceOrganizationAddress.addressKind), asc(commerceOrganizationAddress.id));
  return { success: true, value: addresses.map(readableAddress) };
}

async function clearDefaultAddress(
  transaction: DatabaseTransaction,
  organizationId: string,
  addressKind: AddressKind,
  exceptAddressId?: string,
): Promise<void> {
  const filters = [
    eq(commerceOrganizationAddress.organizationId, organizationId),
    eq(commerceOrganizationAddress.addressKind, addressKind),
    eq(commerceOrganizationAddress.isDefault, true),
  ];
  if (exceptAddressId !== undefined)
    filters.push(ne(commerceOrganizationAddress.id, exceptAddressId));
  await transaction
    .update(commerceOrganizationAddress)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(and(...filters));
}

export async function createAddress(
  userId: string,
  organizationId: string,
  input: AddressInput,
): Promise<Result<ReturnType<typeof readableAddress>, CommerceOrganizationsError>> {
  const access = await requireMembershipRole(userId, organizationId, ADDRESS_MANAGERS);
  if (!access.success) return access;
  const encrypted = encryptAddress(input);
  if (!encrypted.success) return encrypted;
  const addressLineOneEncrypted = encrypted.value.addressLineOneEncrypted;
  if (addressLineOneEncrypted === undefined) {
    throw new Error("A new commerce address must contain address line one.");
  }

  const address = await db.transaction(async (transaction) => {
    const occurredAt = new Date();
    if (input.isDefault) await clearDefaultAddress(transaction, organizationId, input.addressKind);
    const [createdAddress] = await transaction
      .insert(commerceOrganizationAddress)
      .values({
        organizationId,
        addressKind: input.addressKind,
        label: input.label,
        countryCode: input.countryCode,
        regionCode: input.regionCode,
        locality: input.locality,
        postalCode: input.postalCode,
        recipientNameEncrypted: encrypted.value.recipientNameEncrypted,
        addressLineOneEncrypted,
        addressLineTwoEncrypted: encrypted.value.addressLineTwoEncrypted,
        phoneEncrypted: encrypted.value.phoneEncrypted,
        isDefault: input.isDefault,
        createdByUserId: userId,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      })
      .returning();
    if (!createdAddress) throw new Error("Address insert returned no row.");
    await appendAuditOrThrow(transaction, {
      organizationId,
      eventKind: "address_changed",
      actorUserId: userId,
      actorMemberRoleSnapshot: access.value.role,
      targetEntityType: "commerce_organization_address",
      targetEntityId: createdAddress.id,
      payload: { action: "created", addressKind: input.addressKind, isDefault: input.isDefault },
      occurredAt,
    });
    return createdAddress;
  });
  return { success: true, value: readableAddress(address) };
}

export async function updateAddress(
  userId: string,
  organizationId: string,
  addressId: string,
  patch: UpdateAddressInput,
): Promise<Result<ReturnType<typeof readableAddress>, CommerceOrganizationsError>> {
  const access = await requireMembershipRole(userId, organizationId, ADDRESS_MANAGERS);
  if (!access.success) return access;
  const [existing] = await db
    .select()
    .from(commerceOrganizationAddress)
    .where(
      and(
        eq(commerceOrganizationAddress.id, addressId),
        eq(commerceOrganizationAddress.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!existing) return { success: false, error: { type: "NOT_FOUND" } };
  const encrypted = encryptAddress(patch);
  if (!encrypted.success) return encrypted;
  const addressKind = patch.addressKind ?? existing.addressKind;

  const updated = await db.transaction(async (transaction) => {
    const occurredAt = new Date();
    if (
      patch.isDefault === true ||
      (existing.isDefault &&
        patch.addressKind !== undefined &&
        patch.addressKind !== existing.addressKind)
    ) {
      await clearDefaultAddress(transaction, organizationId, addressKind, addressId);
    }
    const [address] = await transaction
      .update(commerceOrganizationAddress)
      .set({
        addressKind: patch.addressKind,
        label: patch.label,
        countryCode: patch.countryCode,
        regionCode: patch.regionCode,
        locality: patch.locality,
        postalCode: patch.postalCode,
        recipientNameEncrypted:
          patch.recipientName === undefined ? undefined : encrypted.value.recipientNameEncrypted,
        addressLineOneEncrypted:
          patch.addressLineOne === undefined ? undefined : encrypted.value.addressLineOneEncrypted,
        addressLineTwoEncrypted:
          patch.addressLineTwo === undefined ? undefined : encrypted.value.addressLineTwoEncrypted,
        phoneEncrypted: patch.phone === undefined ? undefined : encrypted.value.phoneEncrypted,
        isDefault: patch.isDefault,
        updatedAt: occurredAt,
      })
      .where(
        and(
          eq(commerceOrganizationAddress.id, addressId),
          eq(commerceOrganizationAddress.organizationId, organizationId),
        ),
      )
      .returning();
    if (!address) return null;
    await appendAuditOrThrow(transaction, {
      organizationId,
      eventKind: "address_changed",
      actorUserId: userId,
      actorMemberRoleSnapshot: access.value.role,
      targetEntityType: "commerce_organization_address",
      targetEntityId: addressId,
      payload: { action: "updated", changedFields: Object.keys(patch).toSorted() },
      occurredAt,
    });
    return address;
  });
  return updated
    ? { success: true, value: readableAddress(updated) }
    : { success: false, error: { type: "NOT_FOUND" } };
}

export async function submitVerificationEvidence(input: {
  readonly userId: string;
  readonly organizationId: string;
  readonly verificationKind: VerificationKind;
  readonly documentKind: DocumentKind;
  readonly evidenceBytes: Buffer;
  readonly mediaType: string;
  readonly originalFileName: string;
}): Promise<Result<Verification, CommerceOrganizationsError>> {
  const access = await requireMembershipRole(
    input.userId,
    input.organizationId,
    VERIFICATION_MANAGERS,
  );
  if (!access.success) return access;
  const encryptedDocument = encryptCommerceDocument(input.evidenceBytes);
  if (!encryptedDocument.success) {
    return { success: false, error: { type: "PII_ENCRYPTION_UNAVAILABLE" } };
  }
  const encryptedFileName = encryptOptionalPii(input.originalFileName);
  if (!encryptedFileName.success) return encryptedFileName;

  const documentId = randomUUID();
  const uploaded = await uploadPrivateCommerceDocument({
    organizationId: input.organizationId,
    documentId,
    contentSha256: encryptedDocument.value.contentSha256,
    documentBytes: encryptedDocument.value.ciphertext,
    mediaType: "application/octet-stream",
    downloadFileName: `${documentId}.bin`,
  });
  if (!uploaded.success) {
    return {
      success: false,
      error: {
        type:
          uploaded.error.type === "NOT_CONFIGURED" ? "STORAGE_NOT_CONFIGURED" : "STORAGE_FAILED",
      },
    };
  }

  try {
    const verification = await db.transaction(async (transaction) => {
      const occurredAt = new Date();
      const [document] = await transaction
        .insert(commerceEncryptedDocument)
        .values({
          id: documentId,
          organizationId: input.organizationId,
          documentKind: input.documentKind,
          // Upload completion is not a malware verdict. A scanner must promote this
          // document to `available`; pending bytes are never downloadable or reviewable.
          state: "pending_scan",
          storageProvider: "backblaze_b2",
          objectStorageKey: uploaded.value.objectKey,
          mediaType: input.mediaType,
          fileByteSize: input.evidenceBytes.length,
          contentSha256: encryptedDocument.value.contentSha256,
          encryptionAlgorithm: encryptedDocument.value.encryptionAlgorithm,
          encryptionKeyVersion: encryptedDocument.value.encryptionKeyVersion,
          encryptedDataKey: encryptedDocument.value.encryptedDataKey,
          initializationVector: encryptedDocument.value.initializationVector,
          originalFileNameEncrypted: encryptedFileName.value,
          uploadedByUserId: input.userId,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        })
        .returning();
      if (!document) throw new Error("Document insert returned no row.");
      const [createdVerification] = await transaction
        .insert(commerceOrganizationVerification)
        .values({
          organizationId: input.organizationId,
          verificationKind: input.verificationKind,
          state: "pending",
          evidenceDocumentId: document.id,
          submittedByUserId: input.userId,
          submittedAt: occurredAt,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        })
        .returning();
      if (!createdVerification) throw new Error("Verification insert returned no row.");
      await appendAuditOrThrow(transaction, {
        organizationId: input.organizationId,
        eventKind: "document_uploaded",
        actorUserId: input.userId,
        actorMemberRoleSnapshot: access.value.role,
        targetEntityType: "commerce_organization_verification",
        targetEntityId: createdVerification.id,
        payload: {
          documentId,
          documentKind: input.documentKind,
          verificationKind: input.verificationKind,
        },
        occurredAt,
      });
      return createdVerification;
    });
    return { success: true, value: verification };
  } catch (submissionError: unknown) {
    const uniqueConflict = isUniqueViolation(submissionError);
    const cleanup = await deletePrivateCommerceDocument(uploaded.value.objectKey);
    if (!cleanup.success) {
      return {
        success: false,
        error: {
          type: "STORAGE_CLEANUP_FAILED",
          originalFailure: uniqueConflict ? "CONFLICT" : "DATABASE_FAILURE",
        },
      };
    }
    if (uniqueConflict) {
      return {
        success: false,
        error: { type: "CONFLICT", message: "A verification of this kind is already pending." },
      };
    }
    throw submissionError;
  }
}

async function canReadVerification(userId: string, organizationId: string): Promise<boolean> {
  const membership = await activeMembership(userId, organizationId);
  if (membership && VERIFICATION_READERS.includes(membership.role)) return true;
  const staff = await requirePlatformCapability(userId, "moderate_commerce");
  return staff.success;
}

export async function recordDocumentScannerVerdict(input: {
  readonly scannerUserId: string;
  readonly organizationId: string;
  readonly documentId: string;
  readonly verdict: Extract<DocumentState, "available" | "quarantined">;
}): Promise<
  Result<{ readonly documentId: string; readonly state: DocumentState }, CommerceOrganizationsError>
> {
  const capability = await requirePlatformCapability(input.scannerUserId, "moderate_commerce");
  if (!capability.success) {
    return { success: false, error: { type: "PLATFORM_CAPABILITY_REQUIRED" } };
  }

  const outcome = await db.transaction(async (transaction): Promise<ScannerVerdictOutcome> => {
    const [verification] = await transaction
      .select({
        id: commerceOrganizationVerification.id,
        submittedByUserId: commerceOrganizationVerification.submittedByUserId,
      })
      .from(commerceOrganizationVerification)
      .where(
        and(
          eq(commerceOrganizationVerification.organizationId, input.organizationId),
          eq(commerceOrganizationVerification.evidenceDocumentId, input.documentId),
          eq(commerceOrganizationVerification.state, "pending"),
        ),
      )
      .for("update");
    if (!verification) return { status: "not_pending" };
    if (input.verdict === "quarantined" && verification.submittedByUserId === input.scannerUserId) {
      return { status: "self_review_forbidden" };
    }

    const occurredAt = new Date();
    const [document] = await transaction
      .update(commerceEncryptedDocument)
      .set({ state: input.verdict, updatedAt: occurredAt })
      .where(
        and(
          eq(commerceEncryptedDocument.id, input.documentId),
          eq(commerceEncryptedDocument.organizationId, input.organizationId),
          eq(commerceEncryptedDocument.state, "pending_scan"),
        ),
      )
      .returning({
        documentId: commerceEncryptedDocument.id,
        organizationId: commerceEncryptedDocument.organizationId,
        state: commerceEncryptedDocument.state,
      });
    if (!document) return { status: "not_pending" };

    if (input.verdict === "quarantined") {
      const [rejectedVerification] = await transaction
        .update(commerceOrganizationVerification)
        .set({
          state: "rejected",
          reviewedByUserId: input.scannerUserId,
          decisionReason: "Evidence quarantined by the document scanner.",
          decidedAt: occurredAt,
          updatedAt: occurredAt,
        })
        .where(
          and(
            eq(commerceOrganizationVerification.id, verification.id),
            eq(commerceOrganizationVerification.state, "pending"),
          ),
        )
        .returning({ id: commerceOrganizationVerification.id });
      if (!rejectedVerification) return { status: "not_pending" };
    }

    await appendAuditOrThrow(transaction, {
      organizationId: document.organizationId,
      eventKind: "document_state_changed",
      actorUserId: input.scannerUserId,
      actorMemberRoleSnapshot: null,
      targetEntityType: "commerce_encrypted_document",
      targetEntityId: document.documentId,
      payload: { scannerVerdict: input.verdict },
      occurredAt,
    });
    if (input.verdict === "quarantined") {
      await appendAuditOrThrow(transaction, {
        organizationId: document.organizationId,
        eventKind: "verification_decided",
        actorUserId: input.scannerUserId,
        actorMemberRoleSnapshot: null,
        targetEntityType: "commerce_organization_verification",
        targetEntityId: verification.id,
        payload: { decision: "rejected", reasonCode: "document_quarantined" },
        occurredAt,
      });
    }
    return {
      status: "recorded",
      documentId: document.documentId,
      state: document.state,
    };
  });

  switch (outcome.status) {
    case "recorded":
      return {
        success: true,
        value: { documentId: outcome.documentId, state: outcome.state },
      };
    case "self_review_forbidden":
      return { success: false, error: { type: "SELF_REVIEW_FORBIDDEN" } };
    case "not_pending":
      return {
        success: false,
        error: { type: "CONFLICT", message: "Document is not awaiting a scanner verdict." },
      };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled scanner verdict outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export async function listVerifications(
  userId: string,
  organizationId: string,
): Promise<Result<readonly Verification[], CommerceOrganizationsError>> {
  if (!(await canReadVerification(userId, organizationId))) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }
  const verifications = await db
    .select()
    .from(commerceOrganizationVerification)
    .where(eq(commerceOrganizationVerification.organizationId, organizationId))
    .orderBy(asc(commerceOrganizationVerification.submittedAt));
  return { success: true, value: verifications };
}

export async function downloadVerificationEvidence(input: {
  readonly userId: string;
  readonly organizationId: string;
  readonly verificationId: string;
}): Promise<
  Result<
    { readonly bytes: Buffer; readonly mediaType: string; readonly fileName: string },
    CommerceOrganizationsError
  >
> {
  if (!(await canReadVerification(input.userId, input.organizationId))) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }
  const [document] = await db
    .select({
      objectStorageKey: commerceEncryptedDocument.objectStorageKey,
      mediaType: commerceEncryptedDocument.mediaType,
      encryptedDataKey: commerceEncryptedDocument.encryptedDataKey,
      initializationVector: commerceEncryptedDocument.initializationVector,
      originalFileNameEncrypted: commerceEncryptedDocument.originalFileNameEncrypted,
    })
    .from(commerceOrganizationVerification)
    .innerJoin(
      commerceEncryptedDocument,
      and(
        eq(commerceEncryptedDocument.id, commerceOrganizationVerification.evidenceDocumentId),
        eq(
          commerceEncryptedDocument.organizationId,
          commerceOrganizationVerification.organizationId,
        ),
      ),
    )
    .where(
      and(
        eq(commerceOrganizationVerification.id, input.verificationId),
        eq(commerceOrganizationVerification.organizationId, input.organizationId),
        eq(commerceEncryptedDocument.state, "available"),
      ),
    )
    .limit(1);
  if (!document) return { success: false, error: { type: "NOT_FOUND" } };

  const downloaded = await downloadPrivateCommerceDocument(document.objectStorageKey);
  if (!downloaded.success) {
    return {
      success: false,
      error: {
        type:
          downloaded.error.type === "NOT_CONFIGURED" ? "STORAGE_NOT_CONFIGURED" : "STORAGE_FAILED",
      },
    };
  }
  const decrypted = decryptCommerceDocument({
    ciphertext: downloaded.value.ciphertext,
    encryptedDataKey: document.encryptedDataKey,
    initializationVector: document.initializationVector,
  });
  if (!decrypted.success) return { success: false, error: { type: "STORAGE_FAILED" } };
  return {
    success: true,
    value: {
      bytes: decrypted.value,
      mediaType: document.mediaType,
      fileName: decryptOptionalPii(document.originalFileNameEncrypted) ?? "evidence",
    },
  };
}

export async function decideVerification(input: {
  readonly moderatorUserId: string;
  readonly organizationId: string;
  readonly verificationId: string;
  readonly decision: Extract<VerificationState, "approved" | "rejected">;
  readonly reason?: string;
}): Promise<Result<Verification, CommerceOrganizationsError>> {
  const capability = await requirePlatformCapability(input.moderatorUserId, "moderate_commerce");
  if (!capability.success) {
    return { success: false, error: { type: "PLATFORM_CAPABILITY_REQUIRED" } };
  }
  const outcome = await db.transaction(
    async (transaction): Promise<VerificationDecisionOutcome> => {
      const [existing] = await transaction
        .select({ verification: commerceOrganizationVerification })
        .from(commerceOrganizationVerification)
        .innerJoin(
          commerceEncryptedDocument,
          and(
            eq(commerceEncryptedDocument.id, commerceOrganizationVerification.evidenceDocumentId),
            eq(
              commerceEncryptedDocument.organizationId,
              commerceOrganizationVerification.organizationId,
            ),
          ),
        )
        .where(
          and(
            eq(commerceOrganizationVerification.id, input.verificationId),
            eq(commerceOrganizationVerification.organizationId, input.organizationId),
            eq(commerceOrganizationVerification.state, "pending"),
            eq(commerceEncryptedDocument.state, "available"),
          ),
        )
        .for("update");
      if (!existing) return { status: "not_found" };
      if (existing.verification.submittedByUserId === input.moderatorUserId) {
        return { status: "self_review" };
      }

      const occurredAt = new Date();
      const [verification] = await transaction
        .update(commerceOrganizationVerification)
        .set({
          state: input.decision,
          reviewedByUserId: input.moderatorUserId,
          decisionReason: input.decision === "rejected" ? input.reason : null,
          decidedAt: occurredAt,
          updatedAt: occurredAt,
        })
        .where(
          and(
            eq(commerceOrganizationVerification.id, input.verificationId),
            eq(commerceOrganizationVerification.organizationId, input.organizationId),
            eq(commerceOrganizationVerification.state, "pending"),
            eq(
              commerceOrganizationVerification.evidenceDocumentId,
              existing.verification.evidenceDocumentId,
            ),
          ),
        )
        .returning();
      if (!verification) return { status: "conflict" };
      await appendAuditOrThrow(transaction, {
        organizationId: input.organizationId,
        eventKind: "verification_decided",
        actorUserId: input.moderatorUserId,
        actorMemberRoleSnapshot: null,
        targetEntityType: "commerce_organization_verification",
        targetEntityId: input.verificationId,
        payload: { decision: input.decision, tradeStateChanged: false },
        occurredAt,
      });
      return { status: "decided", verification };
    },
  );
  switch (outcome.status) {
    case "decided":
      return { success: true, value: outcome.verification };
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "self_review":
      return { success: false, error: { type: "SELF_REVIEW_FORBIDDEN" } };
    case "conflict":
      return {
        success: false,
        error: { type: "CONFLICT", message: "Verification was already decided." },
      };
    default: {
      const exhaustiveOutcome: never = outcome;
      throw new Error(
        `Unhandled verification decision outcome: ${JSON.stringify(exhaustiveOutcome)}`,
      );
    }
  }
}
