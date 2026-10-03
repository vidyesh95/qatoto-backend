import { describe, expect, it } from "vitest";

import {
  AddKindLinkSchema,
  CreateOfferingSchema,
  LinkSupplierSchema,
  ModerateOfferingSchema,
  ModerateProductSchema,
  OfferingParamsSchema,
  ProductParamsSchema,
  RouteOrganizationIdSchema,
  SetCoverageSchema,
  SupplierParamsSchema,
  UpdateOfferingSchema,
  UpsertProfileSchema,
} from "./commerce-providers.schemas.js";

describe("commerce-providers.schemas", () => {
  describe("Profile, Offering & Moderation Schemas", () => {
    it("validates UpsertProfileSchema", () => {
      const parsed = UpsertProfileSchema.safeParse({
        publicSummary: "Leading global customs brokerage firm.",
        acceptingRequests: true,
        serviceRegionSummary: "North America & Europe",
      });
      expect(parsed.success).toBe(true);
    });

    it("validates AddKindLinkSchema", () => {
      expect(AddKindLinkSchema.safeParse({ providerKind: "customs_broker" }).success).toBe(true);
      expect(AddKindLinkSchema.safeParse({ providerKind: "invalid_kind" }).success).toBe(false);
    });

    it("validates OfferingParamsSchema, ProductParamsSchema, SupplierParamsSchema", () => {
      expect(OfferingParamsSchema.safeParse({ offeringId: "off_1" }).success).toBe(true);
      expect(OfferingParamsSchema.safeParse({ offeringId: "" }).success).toBe(false);

      expect(ProductParamsSchema.safeParse({ productId: "prod_1" }).success).toBe(true);
      expect(ProductParamsSchema.safeParse({ productId: "" }).success).toBe(false);

      expect(SupplierParamsSchema.safeParse({ supplierId: "sup_1" }).success).toBe(true);
      expect(SupplierParamsSchema.safeParse({ supplierId: "" }).success).toBe(false);

      expect(RouteOrganizationIdSchema.safeParse("org_1").success).toBe(true);
      expect(RouteOrganizationIdSchema.safeParse("").success).toBe(false);
    });

    it("validates ModerateOfferingSchema and ModerateProductSchema", () => {
      expect(ModerateOfferingSchema.safeParse({ decision: "approve", reason: "All documents verified" }).success).toBe(
        true,
      );
      expect(ModerateOfferingSchema.safeParse({ decision: "invalid" }).success).toBe(false);

      expect(ModerateProductSchema.safeParse({ moderationState: "approved" }).success).toBe(true);
      expect(ModerateProductSchema.safeParse({ moderationState: "invalid" }).success).toBe(false);
    });

    it("validates LinkSupplierSchema", () => {
      expect(LinkSupplierSchema.safeParse({ commerceOrganizationId: "org_123" }).success).toBe(true);
      expect(LinkSupplierSchema.safeParse({ commerceOrganizationId: "" }).success).toBe(false);
    });
  });

  describe("CreateOfferingSchema & UpdateOfferingSchema", () => {
    const validFreightOffering = {
      providerKind: "freight_forwarder" as const,
      title: "Ocean FCL/LCL Freight Service",
      pricingModel: "quote_only" as const,
      detail: {
        kind: "freight_forwarder" as const,
        transportModes: ["sea"] as ("air" | "sea" | "land" | "rail" | "multimodal")[],
        supportsConsolidation: true,
        supportsContainers: true,
        supportsHazardousGoods: false,
      },
    };

    it("accepts matching providerKind and detail.kind", () => {
      const parsed = CreateOfferingSchema.safeParse(validFreightOffering);
      expect(parsed.success).toBe(true);
    });

    it("rejects mismatched providerKind and detail.kind", () => {
      const parsed = CreateOfferingSchema.safeParse({
        ...validFreightOffering,
        providerKind: "logistics_operator",
      });
      expect(parsed.success).toBe(false);
    });

    it("validates UpdateOfferingSchema", () => {
      const parsed = UpdateOfferingSchema.safeParse({
        title: "Updated Ocean FCL Service",
        pricingModel: "fixed_fee",
        indicativePriceMinInCents: 50000,
      });
      expect(parsed.success).toBe(true);
    });

    it("validates SetCoverageSchema", () => {
      const parsed = SetCoverageSchema.safeParse({
        coverages: [
          {
            originCountryCode: "IN",
            destinationCountryCode: "US",
            supportsConsolidation: true,
          },
        ],
      });
      expect(parsed.success).toBe(true);
    });
  });
});
