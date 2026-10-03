import { describe, expect, it } from "vitest";

import {
  AddressParamsSchema,
  CreateCommerceOrganizationAddressSchema,
  CreateCommerceOrganizationMemberSchema,
  CreateCommerceOrganizationSchema,
  DecideCommerceVerificationSchema,
  DocumentParamsSchema,
  EmptyObjectSchema,
  EmptyRequestBodySchema,
  MemberParamsSchema,
  OrganizationIdSchema,
  RecordCommerceDocumentScannerVerdictSchema,
  SubmitCommerceVerificationSchema,
  TransitionCommerceTradeStateSchema,
  UpdateCommerceOrganizationAddressSchema,
  UpdateCommerceOrganizationMemberSchema,
  UpdateCommerceOrganizationSchema,
  VerificationParamsSchema,
} from "./commerce-organizations.schemas.js";

describe("commerce-organizations.schemas", () => {
  describe("Organization ID & Parameter Schemas", () => {
    it("validates OrganizationIdSchema", () => {
      expect(OrganizationIdSchema.safeParse({ organizationId: "org_1" }).success).toBe(true);
      expect(OrganizationIdSchema.safeParse({ organizationId: "" }).success).toBe(false);
    });

    it("validates Member, Address, Verification, and Document params with UUIDs", () => {
      const validOrg = "org_123";
      const validUuid = "123e4567-e89b-12d3-a456-426614174000";

      expect(MemberParamsSchema.safeParse({ organizationId: validOrg, memberId: validUuid }).success).toBe(true);
      expect(AddressParamsSchema.safeParse({ organizationId: validOrg, addressId: validUuid }).success).toBe(true);
      expect(VerificationParamsSchema.safeParse({ organizationId: validOrg, verificationId: validUuid }).success).toBe(
        true,
      );
      expect(DocumentParamsSchema.safeParse({ organizationId: validOrg, documentId: validUuid }).success).toBe(true);

      expect(MemberParamsSchema.safeParse({ organizationId: validOrg, memberId: "not-a-uuid" }).success).toBe(false);
    });

    it("validates EmptyObjectSchema & EmptyRequestBodySchema", () => {
      expect(EmptyObjectSchema.safeParse({}).success).toBe(true);
      expect(EmptyRequestBodySchema.safeParse(undefined).success).toBe(true);
      expect(EmptyRequestBodySchema.safeParse({}).success).toBe(true);
    });
  });

  describe("CreateCommerceOrganizationSchema & UpdateCommerceOrganizationSchema", () => {
    const validOrg = {
      slug: "apex-industrial-parts",
      legalName: "Apex Industrial Parts GmbH",
      displayName: "Apex Parts",
      organizationType: "company" as const,
      countryCode: "DE",
      websiteUrl: "https://apexparts.de",
    };

    it("accepts valid organization creation payload", () => {
      const parsed = CreateCommerceOrganizationSchema.safeParse(validOrg);
      expect(parsed.success).toBe(true);
    });

    it("rejects non-https websiteUrl", () => {
      expect(
        CreateCommerceOrganizationSchema.safeParse({
          ...validOrg,
          websiteUrl: "http://insecure.com",
        }).success,
      ).toBe(false);
    });

    it("rejects invalid slug format (uppercase, spaces, symbols)", () => {
      expect(
        CreateCommerceOrganizationSchema.safeParse({
          ...validOrg,
          slug: "Apex_Parts!",
        }).success,
      ).toBe(false);
    });

    it("validates UpdateCommerceOrganizationSchema", () => {
      expect(UpdateCommerceOrganizationSchema.safeParse({ displayName: "Apex Global" }).success).toBe(true);
      expect(UpdateCommerceOrganizationSchema.safeParse({}).success).toBe(false);
    });
  });

  describe("Member schemas", () => {
    it("validates CreateCommerceOrganizationMemberSchema", () => {
      const parsed = CreateCommerceOrganizationMemberSchema.safeParse({
        userId: "user_456",
        role: "seller",
      });
      expect(parsed.success).toBe(true);
    });

    it("validates UpdateCommerceOrganizationMemberSchema separation of role and state", () => {
      expect(UpdateCommerceOrganizationMemberSchema.safeParse({ role: "administrator" }).success).toBe(true);
      expect(UpdateCommerceOrganizationMemberSchema.safeParse({ state: "suspended" }).success).toBe(true);

      // Mutually exclusive in one request
      expect(
        UpdateCommerceOrganizationMemberSchema.safeParse({
          role: "administrator",
          state: "suspended",
        }).success,
      ).toBe(false);
    });
  });

  describe("Address schemas", () => {
    const validAddress = {
      addressKind: "warehouse" as const,
      countryCode: "DE",
      locality: "Frankfurt",
      addressLineOne: "Industriestrasse 42",
      isDefault: true,
    };

    it("validates CreateCommerceOrganizationAddressSchema", () => {
      expect(CreateCommerceOrganizationAddressSchema.safeParse(validAddress).success).toBe(true);
    });

    it("validates UpdateCommerceOrganizationAddressSchema", () => {
      expect(UpdateCommerceOrganizationAddressSchema.safeParse({ locality: "Berlin" }).success).toBe(true);
      expect(UpdateCommerceOrganizationAddressSchema.safeParse({}).success).toBe(false);
    });
  });

  describe("Verification, Scanner Verdict & Trade State", () => {
    it("validates SubmitCommerceVerificationSchema", () => {
      expect(
        SubmitCommerceVerificationSchema.safeParse({
          verificationKind: "business_registration",
          documentKind: "business_registration",
        }).success,
      ).toBe(true);
    });

    it("validates DecideCommerceVerificationSchema discriminated union", () => {
      expect(DecideCommerceVerificationSchema.safeParse({ decision: "approved" }).success).toBe(true);
      expect(
        DecideCommerceVerificationSchema.safeParse({
          decision: "rejected",
          reason: "Tax certificate is illegible.",
        }).success,
      ).toBe(true);

      expect(DecideCommerceVerificationSchema.safeParse({ decision: "rejected" }).success).toBe(false);
    });

    it("validates RecordCommerceDocumentScannerVerdictSchema", () => {
      expect(RecordCommerceDocumentScannerVerdictSchema.safeParse({ verdict: "available" }).success).toBe(true);
      expect(RecordCommerceDocumentScannerVerdictSchema.safeParse({ verdict: "quarantined" }).success).toBe(true);
      expect(RecordCommerceDocumentScannerVerdictSchema.safeParse({ verdict: "infected" }).success).toBe(false);
    });

    it("validates TransitionCommerceTradeStateSchema", () => {
      expect(TransitionCommerceTradeStateSchema.safeParse({ tradeState: "active" }).success).toBe(true);
      expect(
        TransitionCommerceTradeStateSchema.safeParse({ tradeState: "suspended", reason: "Audit issue" }).success,
      ).toBe(true);
      expect(TransitionCommerceTradeStateSchema.safeParse({ tradeState: "invalid" }).success).toBe(false);
    });
  });
});
