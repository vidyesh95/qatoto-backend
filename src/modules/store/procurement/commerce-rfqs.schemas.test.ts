import { describe, expect, it } from "vitest";

import {
  CreateDraftRfqSchema,
  EmptyObjectSchema,
  InviteProvidersSchema,
  ListQuerySchema,
  RfqIdParamsSchema,
  UpdateDraftRfqSchema,
} from "./commerce-rfqs.schemas.js";

describe("commerce-rfqs.schemas", () => {
  describe("ID Params & Empty schemas", () => {
    it("validates empty object", () => {
      expect(EmptyObjectSchema.safeParse({}).success).toBe(true);
      expect(EmptyObjectSchema.safeParse({ extra: 1 }).success).toBe(false);
    });

    it("validates UUID RfqIdParamsSchema", () => {
      expect(RfqIdParamsSchema.safeParse({ rfqId: "123e4567-e89b-12d3-a456-426614174000" }).success).toBe(true);
      expect(RfqIdParamsSchema.safeParse({ rfqId: "non-uuid" }).success).toBe(false);
    });
  });

  describe("CreateDraftRfqSchema", () => {
    const validDraft = {
      title: "Custom CNC Enclosures",
      visibility: "matched_providers" as const,
      responseDeadlineAt: "2026-10-15T00:00:00.000Z",
      settlementCurrency: "USD",
      productLines: [],
      serviceLines: [],
    };

    it("accepts valid minimal draft RFQ", () => {
      const parsed = CreateDraftRfqSchema.safeParse(validDraft);
      expect(parsed.success).toBe(true);
    });

    it("accepts delivery window when both startsAt and endsAt are provided", () => {
      const parsed = CreateDraftRfqSchema.safeParse({
        ...validDraft,
        desiredDeliveryStartsAt: "2026-11-01T00:00:00.000Z",
        desiredDeliveryEndsAt: "2026-11-15T00:00:00.000Z",
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects delivery window when only one bound is provided", () => {
      const onlyStart = CreateDraftRfqSchema.safeParse({
        ...validDraft,
        desiredDeliveryStartsAt: "2026-11-01T00:00:00.000Z",
      });
      const onlyEnd = CreateDraftRfqSchema.safeParse({
        ...validDraft,
        desiredDeliveryEndsAt: "2026-11-15T00:00:00.000Z",
      });
      expect(onlyStart.success).toBe(false);
      expect(onlyEnd.success).toBe(false);
    });
  });

  describe("UpdateDraftRfqSchema", () => {
    it("accepts partial updates", () => {
      const parsed = UpdateDraftRfqSchema.safeParse({
        title: "Updated CNC Enclosures Spec",
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects empty update object", () => {
      expect(UpdateDraftRfqSchema.safeParse({}).success).toBe(false);
    });
  });

  describe("InviteProvidersSchema & ListQuerySchema", () => {
    it("validates InviteProvidersSchema", () => {
      const parsed = InviteProvidersSchema.safeParse({
        providerOrganizationIds: ["org_p1", "org_p2"],
      });
      expect(parsed.success).toBe(true);

      expect(InviteProvidersSchema.safeParse({ providerOrganizationIds: [] }).success).toBe(false);
    });

    it("validates ListQuerySchema states and limit", () => {
      const data = ListQuerySchema.parse({
        state: "open",
        limit: "15",
      });
      expect(data.state).toBe("open");
      expect(data.limit).toBe(15);
    });
  });
});
