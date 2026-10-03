import { describe, expect, it } from "vitest";

import {
  AddOrganizationMediaSchema,
  CertificationParamsSchema,
  DecideCertificationSchema,
  ListCertificationsForModerationQuerySchema,
  MediaParamsSchema,
  OrganizationCertificationParamsSchema,
  OrganizationIdSchema,
  ReorderOrganizationMediaSchema,
  ReplaceCapabilitiesSchema,
  ReplaceSiteAccessSchema,
  ReplaceStakeholdersSchema,
  StakeholderParamsSchema,
  SubmitCertificationSchema,
  UpsertSellerProfileSchema,
} from "#src/modules/store/organizations/commerce-seller-profile.schemas.js";

describe("commerce-seller-profile.schemas", () => {
  describe("Param schemas", () => {
    it("validates OrganizationIdSchema", () => {
      expect(OrganizationIdSchema.parse({ organizationId: "org_1" }).organizationId).toBe("org_1");
      expect(OrganizationIdSchema.safeParse({ organizationId: "" }).success).toBe(false);
    });

    it("validates MediaParamsSchema with UUID", () => {
      const validUuid = "123e4567-e89b-12d3-a456-426614174000";
      expect(
        MediaParamsSchema.parse({
          organizationId: "org_1",
          mediaId: validUuid,
        }).mediaId,
      ).toBe(validUuid);

      expect(
        MediaParamsSchema.safeParse({
          organizationId: "org_1",
          mediaId: "not-a-uuid",
        }).success,
      ).toBe(false);
    });

    it("validates StakeholderParamsSchema", () => {
      const validUuid = "123e4567-e89b-12d3-a456-426614174000";
      expect(
        StakeholderParamsSchema.parse({
          organizationId: "org_1",
          stakeholderId: validUuid,
        }).stakeholderId,
      ).toBe(validUuid);
    });

    it("validates CertificationParamsSchema and OrganizationCertificationParamsSchema", () => {
      const validUuid = "123e4567-e89b-12d3-a456-426614174000";
      expect(CertificationParamsSchema.parse({ certificationId: validUuid }).certificationId).toBe(validUuid);

      expect(
        OrganizationCertificationParamsSchema.parse({
          organizationId: "org_1",
          certificationId: validUuid,
        }).certificationId,
      ).toBe(validUuid);
    });
  });

  describe("UpsertSellerProfileSchema", () => {
    it("accepts valid profile fields", () => {
      const parsed = UpsertSellerProfileSchema.parse({
        yearFounded: 2010,
        factoryCount: 2,
        businessType: "manufacturer",
        visitPolicy: "welcome",
        acceptingCustomOrders: true,
        publicSummary: "Precision parts manufacturer since 2010",
      });

      expect(parsed.yearFounded).toBe(2010);
      expect(parsed.businessType).toBe("manufacturer");
    });

    it("rejects future founding year", () => {
      const nextYear = new Date().getUTCFullYear() + 1;
      expect(UpsertSellerProfileSchema.safeParse({ yearFounded: nextYear }).success).toBe(false);
    });

    it("rejects founding year before 1800", () => {
      expect(UpsertSellerProfileSchema.safeParse({ yearFounded: 1799 }).success).toBe(false);
    });

    it("rejects empty update", () => {
      expect(UpsertSellerProfileSchema.safeParse({}).success).toBe(false);
    });

    it("rejects negative counts", () => {
      expect(UpsertSellerProfileSchema.safeParse({ factoryCount: -1 }).success).toBe(false);
    });
  });

  describe("ReplaceSiteAccessSchema", () => {
    it("accepts valid site access rows", () => {
      const parsed = ReplaceSiteAccessSchema.parse({
        rows: [
          {
            accessMode: "road",
            facilityName: "National Highway 1",
            distanceKm: 5,
            notes: "Direct access",
          },
          {
            accessMode: "air",
            facilityName: "Metro Cargo Airport",
            distanceKm: 25,
          },
        ],
      });

      expect(parsed.rows).toHaveLength(2);
    });

    it("rejects more than 12 access rows", () => {
      const rows = Array.from({ length: 13 }, (_, i) => ({
        accessMode: "road" as const,
        facilityName: `Road ${i}`,
      }));

      expect(ReplaceSiteAccessSchema.safeParse({ rows }).success).toBe(false);
    });
  });

  describe("ReplaceStakeholdersSchema", () => {
    it("accepts valid stakeholders", () => {
      const parsed = ReplaceStakeholdersSchema.parse({
        rows: [
          {
            fullName: "Alice Chen",
            roleTitle: "Head of Engineering",
          },
        ],
      });
      expect(parsed.rows[0]?.fullName).toBe("Alice Chen");
    });

    it("rejects more than 12 stakeholders", () => {
      const rows = Array.from({ length: 13 }, (_, i) => ({
        fullName: `Person ${i}`,
        roleTitle: "Engineer",
      }));
      expect(ReplaceStakeholdersSchema.safeParse({ rows }).success).toBe(false);
    });
  });

  describe("ReplaceCapabilitiesSchema", () => {
    it("accepts valid capabilities", () => {
      const parsed = ReplaceCapabilitiesSchema.parse({
        rows: [
          {
            capabilityKind: "oem",
            detail: "High-volume precision tooling",
          },
          {
            capabilityKind: "sample_production",
          },
        ],
      });
      expect(parsed.rows).toHaveLength(2);
    });

    it("rejects more than 6 capabilities", () => {
      const rows = Array.from({ length: 7 }, () => ({
        capabilityKind: "oem" as const,
      }));
      expect(ReplaceCapabilitiesSchema.safeParse({ rows }).success).toBe(false);
    });
  });

  describe("ReorderOrganizationMediaSchema & AddOrganizationMediaSchema", () => {
    it("validates ReorderOrganizationMediaSchema", () => {
      const validUuid = "123e4567-e89b-12d3-a456-426614174000";
      const parsed = ReorderOrganizationMediaSchema.parse({ mediaIdsInOrder: [validUuid] });
      expect(parsed.mediaIdsInOrder).toEqual([validUuid]);
    });

    it("rejects empty mediaIdsInOrder", () => {
      expect(ReorderOrganizationMediaSchema.safeParse({ mediaIdsInOrder: [] }).success).toBe(false);
    });

    it("validates AddOrganizationMediaSchema", () => {
      const parsed = AddOrganizationMediaSchema.parse({
        mediaKind: "factory",
        altText: "Factory exterior",
      });
      expect(parsed.mediaKind).toBe("factory");
    });
  });

  describe("SubmitCertificationSchema", () => {
    it("accepts valid certification", () => {
      const parsed = SubmitCertificationSchema.parse({
        standardName: "ISO 9001:2015",
        standardCode: "iso_9001",
        issuerName: "TUV SUD",
        certificateNumber: "CERT-9001-XYZ",
        validFrom: "2024-01-01",
        validUntil: "2027-01-01",
      });
      expect(parsed.standardName).toBe("ISO 9001:2015");
      expect(parsed.standardCode).toBe("iso_9001");
    });

    it("rejects when validUntil is not after validFrom", () => {
      expect(
        SubmitCertificationSchema.safeParse({
          standardName: "ISO 9001",
          issuerName: "TUV",
          certificateNumber: "123",
          validFrom: "2025-01-01",
          validUntil: "2024-01-01",
        }).success,
      ).toBe(false);

      expect(
        SubmitCertificationSchema.safeParse({
          standardName: "ISO 9001",
          issuerName: "TUV",
          certificateNumber: "123",
          validFrom: "2025-01-01",
          validUntil: "2025-01-01",
        }).success,
      ).toBe(false);
    });

    it("rejects invalid date format", () => {
      expect(
        SubmitCertificationSchema.safeParse({
          standardName: "ISO 9001",
          issuerName: "TUV",
          certificateNumber: "123",
          validFrom: "01/01/2024",
          validUntil: "01/01/2027",
        }).success,
      ).toBe(false);
    });
  });

  describe("ListCertificationsForModerationQuerySchema", () => {
    it("applies default limit of 25", () => {
      const parsed = ListCertificationsForModerationQuerySchema.parse({});
      expect(parsed.limit).toBe(25);
    });

    it("accepts state and cursor", () => {
      const parsed = ListCertificationsForModerationQuerySchema.parse({
        state: "pending",
        cursor: "curs_abc",
        limit: "10",
      });
      expect(parsed.state).toBe("pending");
      expect(parsed.limit).toBe(10);
    });
  });

  describe("DecideCertificationSchema", () => {
    it("accepts approve verdict", () => {
      const parsed = DecideCertificationSchema.parse({ kind: "approve" });
      expect(parsed.kind).toBe("approve");
    });

    it("accepts reject verdict with reason", () => {
      const parsed = DecideCertificationSchema.parse({
        kind: "reject",
        decisionReason: "Certificate expired",
      });
      expect(parsed).toMatchObject({
        kind: "reject",
        decisionReason: "Certificate expired",
      });
    });

    it("rejects reject verdict without decisionReason", () => {
      expect(DecideCertificationSchema.safeParse({ kind: "reject" }).success).toBe(false);
    });
  });
});
