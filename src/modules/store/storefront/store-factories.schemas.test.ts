import { describe, expect, it } from "vitest";

import {
  AuditIdParamsSchema,
  CreateManufacturingInquirySchema,
  FactorySlugParamsSchema,
  InquiryIdParamsSchema,
  ListFactoriesQuerySchema,
  ListManufacturingInquiriesQuerySchema,
  OrganizationIdParamsSchema,
  RecordSiteAuditSchema,
  ReplaceFactoryTermsSchema,
  ReplaceOrganizationSitesSchema,
  ReplaceProductionLinesSchema,
  WithdrawSiteAuditSchema,
} from "./store-factories.schemas.js";

describe("store-factories.schemas", () => {
  describe("ListFactoriesQuerySchema", () => {
    it("applies default limit and parses empty query", () => {
      const data = ListFactoriesQuerySchema.parse({});
      expect(data.limit).toBe(20);
      expect(data.capabilityKind).toBeUndefined();
    });

    it("accepts valid filtering parameters", () => {
      const data = ListFactoriesQuerySchema.parse({
        capabilityKind: "oem",
        countryCode: "IN",
        certification: "iso_9001",
        maxMinimumOrderQuantity: "500",
        limit: "10",
        cursor: "cursor_123",
      });
      expect(data.capabilityKind).toBe("oem");
      expect(data.countryCode).toBe("IN");
      expect(data.certification).toBe("iso_9001");
      expect(data.maxMinimumOrderQuantity).toBe(500);
      expect(data.limit).toBe(10);
    });

    it("rejects lowercase country code", () => {
      const parsed = ListFactoriesQuerySchema.safeParse({ countryCode: "in" });
      expect(parsed.success).toBe(false);
    });

    it("rejects invalid capability kind", () => {
      const parsed = ListFactoriesQuerySchema.safeParse({ capabilityKind: "invalid_kind" });
      expect(parsed.success).toBe(false);
    });

    it("rejects limit out of range (0 or 51)", () => {
      expect(ListFactoriesQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
      expect(ListFactoriesQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
    });

    it("rejects unknown query properties due to strict mode", () => {
      const parsed = ListFactoriesQuerySchema.safeParse({ unexpected: true });
      expect(parsed.success).toBe(false);
    });
  });

  describe("FactorySlugParamsSchema", () => {
    it("accepts valid kebab-case slug", () => {
      expect(FactorySlugParamsSchema.safeParse({ factorySlug: "precision-moulds-ltd" }).success).toBe(true);
      expect(FactorySlugParamsSchema.safeParse({ factorySlug: "factory123" }).success).toBe(true);
    });

    it("rejects uppercase, spaces, and leading/trailing dashes", () => {
      expect(FactorySlugParamsSchema.safeParse({ factorySlug: "Factory-Slug" }).success).toBe(false);
      expect(FactorySlugParamsSchema.safeParse({ factorySlug: "factory slug" }).success).toBe(false);
      expect(FactorySlugParamsSchema.safeParse({ factorySlug: "-leading-dash" }).success).toBe(false);
      expect(FactorySlugParamsSchema.safeParse({ factorySlug: "trailing-dash-" }).success).toBe(false);
      expect(FactorySlugParamsSchema.safeParse({ factorySlug: "" }).success).toBe(false);
    });
  });

  describe("CreateManufacturingInquirySchema", () => {
    const validBase = {
      capabilityKind: "oem" as const,
      productDescription: "Custom precision enclosure with IP67 rating.",
    };

    it("accepts minimal valid inquiry payload", () => {
      const parsed = CreateManufacturingInquirySchema.safeParse(validBase);
      expect(parsed.success).toBe(true);
    });

    it("accepts inquiry with matched both-or-neither pairs", () => {
      const parsed = CreateManufacturingInquirySchema.safeParse({
        ...validBase,
        estimatedAnnualQuantity: 10000,
        unitLabel: "units",
        targetUnitPriceInCents: 1500,
        currency: "USD",
        requiredCertifications: ["iso_9001", "ce_marking"],
        desiredFirstDeliveryAt: "2026-12-01",
        notes: "Strict tolerance within 0.05mm",
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects estimatedAnnualQuantity without unitLabel", () => {
      const parsed = CreateManufacturingInquirySchema.safeParse({
        ...validBase,
        estimatedAnnualQuantity: 5000,
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects unitLabel without estimatedAnnualQuantity", () => {
      const parsed = CreateManufacturingInquirySchema.safeParse({
        ...validBase,
        unitLabel: "pieces",
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects targetUnitPriceInCents without currency", () => {
      const parsed = CreateManufacturingInquirySchema.safeParse({
        ...validBase,
        targetUnitPriceInCents: 2000,
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects currency without targetUnitPriceInCents", () => {
      const parsed = CreateManufacturingInquirySchema.safeParse({
        ...validBase,
        currency: "USD",
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects invalid date format for desiredFirstDeliveryAt", () => {
      const parsed = CreateManufacturingInquirySchema.safeParse({
        ...validBase,
        desiredFirstDeliveryAt: "01-12-2026",
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects lowercase currency code", () => {
      const parsed = CreateManufacturingInquirySchema.safeParse({
        ...validBase,
        targetUnitPriceInCents: 100,
        currency: "usd",
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects more than 8 required certifications", () => {
      const parsed = CreateManufacturingInquirySchema.safeParse({
        ...validBase,
        requiredCertifications: [
          "iso_9001",
          "iso_14001",
          "bsci",
          "sedex_smeta",
          "gots",
          "fsc",
          "ce_marking",
          "fda_registered",
          "iso_9001",
        ],
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe("InquiryIdParamsSchema & ListManufacturingInquiriesQuerySchema", () => {
    it("validates inquiry ID params", () => {
      expect(InquiryIdParamsSchema.safeParse({ inquiryId: "inq_123" }).success).toBe(true);
      expect(InquiryIdParamsSchema.safeParse({ inquiryId: "" }).success).toBe(false);
      expect(InquiryIdParamsSchema.safeParse({ inquiryId: "a".repeat(201) }).success).toBe(false);
    });

    it("validates list inquiries query states and defaults", () => {
      const data = ListManufacturingInquiriesQuerySchema.parse({});
      expect(data.limit).toBe(20);

      expect(ListManufacturingInquiriesQuerySchema.safeParse({ state: "sent" }).success).toBe(true);
      expect(ListManufacturingInquiriesQuerySchema.safeParse({ state: "invalid_state" }).success).toBe(false);
    });
  });

  describe("ReplaceProductionLinesSchema", () => {
    it("accepts valid production lines array", () => {
      const parsed = ReplaceProductionLinesSchema.safeParse({
        productionLines: [
          {
            name: "SMT Line 1",
            processSummary: "High-speed surface mount placement with AOI.",
            monthlyCapacityUnits: 50000,
            unitLabel: "boards",
          },
        ],
      });
      expect(parsed.success).toBe(true);
    });

    it("accepts null monthlyCapacityUnits if unitLabel is provided", () => {
      const parsed = ReplaceProductionLinesSchema.safeParse({
        productionLines: [
          {
            name: "Tooling Workshop",
            processSummary: "Custom CNC mold machining.",
            monthlyCapacityUnits: null,
            unitLabel: "molds",
          },
        ],
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects more than 12 production lines", () => {
      const lines = Array.from({ length: 13 }, (_, i) => ({
        name: `Line ${i}`,
        processSummary: "Summary",
        unitLabel: "units",
      }));
      expect(ReplaceProductionLinesSchema.safeParse({ productionLines: lines }).success).toBe(false);
    });
  });

  describe("ReplaceOrganizationSitesSchema", () => {
    it("accepts valid organization sites", () => {
      const parsed = ReplaceOrganizationSitesSchema.safeParse({
        sites: [
          {
            label: "Main Campus",
            countryCode: "DE",
            locality: "Stuttgart",
            floorAreaSquareMetres: 12000,
            productionStaffCount: 250,
          },
        ],
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects lowercase country code", () => {
      const parsed = ReplaceOrganizationSitesSchema.safeParse({
        sites: [
          {
            label: "Site A",
            countryCode: "de",
          },
        ],
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects more than 12 sites", () => {
      const sites = Array.from({ length: 13 }, (_, i) => ({
        label: `Site ${i}`,
        countryCode: "US",
      }));
      expect(ReplaceOrganizationSitesSchema.safeParse({ sites }).success).toBe(false);
    });
  });

  describe("ReplaceFactoryTermsSchema", () => {
    const validTermsBase = {
      offersSamples: true,
      sampleLeadTimeDays: 7,
      sampleFeeInCents: 5000,
      sampleCurrency: "USD",
      minimumOrderQuantity: 500,
      minimumOrderQuantityUnitLabel: "pieces",
      minimumLeadTimeDays: 14,
      maximumLeadTimeDays: 30,
      acceptingInquiries: true,
    };

    it("accepts fully specified valid factory terms", () => {
      const parsed = ReplaceFactoryTermsSchema.safeParse(validTermsBase);
      expect(parsed.success).toBe(true);
    });

    it("accepts terms when samples are not offered and sample values are null", () => {
      const parsed = ReplaceFactoryTermsSchema.safeParse({
        ...validTermsBase,
        offersSamples: false,
        sampleLeadTimeDays: null,
        sampleFeeInCents: null,
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects non-null sample lead time or fee when offersSamples is false", () => {
      const withFee = ReplaceFactoryTermsSchema.safeParse({
        ...validTermsBase,
        offersSamples: false,
        sampleFeeInCents: 1000,
        sampleLeadTimeDays: null,
      });
      const withLeadTime = ReplaceFactoryTermsSchema.safeParse({
        ...validTermsBase,
        offersSamples: false,
        sampleFeeInCents: null,
        sampleLeadTimeDays: 5,
      });
      expect(withFee.success).toBe(false);
      expect(withLeadTime.success).toBe(false);
    });

    it("rejects MOQ without unit label or vice-versa", () => {
      const moqNoUnit = ReplaceFactoryTermsSchema.safeParse({
        ...validTermsBase,
        minimumOrderQuantity: 100,
        minimumOrderQuantityUnitLabel: null,
      });
      const unitNoMoq = ReplaceFactoryTermsSchema.safeParse({
        ...validTermsBase,
        minimumOrderQuantity: null,
        minimumOrderQuantityUnitLabel: "cartons",
      });
      expect(moqNoUnit.success).toBe(false);
      expect(unitNoMoq.success).toBe(false);
    });

    it("rejects minimumLeadTimeDays > maximumLeadTimeDays", () => {
      const parsed = ReplaceFactoryTermsSchema.safeParse({
        ...validTermsBase,
        minimumLeadTimeDays: 45,
        maximumLeadTimeDays: 30,
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe("RecordSiteAuditSchema & WithdrawSiteAuditSchema", () => {
    it("accepts valid site audit record", () => {
      const parsed = RecordSiteAuditSchema.safeParse({
        auditedAt: "2026-05-15",
        auditorName: "TÜV SÜD Inspector",
        auditorOrganizationName: "TÜV SÜD",
        scopeSummary: "Full social and environmental compliance inspection.",
        siteIds: ["site_1", "site_2"],
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects invalid date format in site audit", () => {
      const parsed = RecordSiteAuditSchema.safeParse({
        auditedAt: "15/05/2026",
        auditorName: "Inspector",
        scopeSummary: "Summary",
      });
      expect(parsed.success).toBe(false);
    });

    it("validates withdraw site audit schema", () => {
      expect(WithdrawSiteAuditSchema.safeParse({ reason: "Material misrepresentation uncovered." }).success).toBe(true);
      expect(WithdrawSiteAuditSchema.safeParse({ reason: "" }).success).toBe(false);
      expect(WithdrawSiteAuditSchema.safeParse({ reason: "a".repeat(2001) }).success).toBe(false);
    });
  });

  describe("AuditIdParamsSchema & OrganizationIdParamsSchema", () => {
    it("validates IDs", () => {
      expect(AuditIdParamsSchema.safeParse({ auditId: "aud_123" }).success).toBe(true);
      expect(AuditIdParamsSchema.safeParse({ auditId: "" }).success).toBe(false);
      expect(OrganizationIdParamsSchema.safeParse({ organizationId: "org_123" }).success).toBe(true);
      expect(OrganizationIdParamsSchema.safeParse({ organizationId: "" }).success).toBe(false);
    });
  });
});
