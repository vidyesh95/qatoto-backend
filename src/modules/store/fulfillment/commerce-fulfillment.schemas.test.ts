import { describe, expect, it } from "vitest";

import {
  AddShipmentLegsSchema,
  AppendShipmentEventSchema,
  CreateShipmentWithLegsSchema,
  EmptyObjectSchema,
  EngagementIdParamsSchema,
  LegIdParamsSchema,
  ListShipmentsQuerySchema,
  OrderIdParamsSchema,
  ShipmentIdParamsSchema,
  ShipmentLegAssignmentSchema,
  ShipmentLegCommandSchema,
} from "./commerce-fulfillment.schemas.js";

describe("commerce-fulfillment.schemas", () => {
  describe("ID Params & EmptyObject", () => {
    it("validates empty object", () => {
      expect(EmptyObjectSchema.safeParse({}).success).toBe(true);
      expect(EmptyObjectSchema.safeParse({ extra: 1 }).success).toBe(false);
    });

    it("validates ID params schemas", () => {
      expect(OrderIdParamsSchema.safeParse({ orderId: "ord_1" }).success).toBe(true);
      expect(OrderIdParamsSchema.safeParse({ orderId: "" }).success).toBe(false);

      expect(ShipmentIdParamsSchema.safeParse({ shipmentId: "shp_1" }).success).toBe(true);
      expect(ShipmentIdParamsSchema.safeParse({ shipmentId: "" }).success).toBe(false);

      expect(LegIdParamsSchema.safeParse({ legId: "leg_1" }).success).toBe(true);
      expect(LegIdParamsSchema.safeParse({ legId: "" }).success).toBe(false);

      expect(EngagementIdParamsSchema.safeParse({ engagementId: "eng_1" }).success).toBe(true);
      expect(EngagementIdParamsSchema.safeParse({ engagementId: "" }).success).toBe(false);
    });
  });

  describe("CreateShipmentWithLegsSchema", () => {
    const validCreate = {
      lines: [
        {
          orderProductLineId: "line_1",
          quantity: 10,
        },
      ],
      packageCount: 2,
      originCountryCode: "IN",
      destinationCountryCode: "US",
      totalWeightGrams: 5000,
    };

    it("accepts valid shipment creation payload", () => {
      const parsed = CreateShipmentWithLegsSchema.safeParse(validCreate);
      expect(parsed.success).toBe(true);
    });

    it("accepts shipment creation with legs", () => {
      const parsed = CreateShipmentWithLegsSchema.safeParse({
        ...validCreate,
        legs: [
          {
            sequence: 0,
            mode: "sea",
            originCountryCode: "IN",
            destinationCountryCode: "US",
          },
        ],
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects empty lines array", () => {
      expect(CreateShipmentWithLegsSchema.safeParse({ ...validCreate, lines: [] }).success).toBe(false);
    });

    it("rejects non-positive packageCount", () => {
      expect(CreateShipmentWithLegsSchema.safeParse({ ...validCreate, packageCount: 0 }).success).toBe(false);
      expect(CreateShipmentWithLegsSchema.safeParse({ ...validCreate, packageCount: -1 }).success).toBe(false);
    });

    it("rejects invalid lowercase country codes", () => {
      expect(
        CreateShipmentWithLegsSchema.safeParse({
          ...validCreate,
          originCountryCode: "in",
        }).success,
      ).toBe(false);
    });
  });

  describe("AddShipmentLegsSchema", () => {
    it("accepts valid legs array", () => {
      const parsed = AddShipmentLegsSchema.safeParse({
        legs: [
          {
            sequence: 1,
            mode: "air",
            originCountryCode: "DE",
            destinationCountryCode: "FR",
          },
        ],
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects empty legs array", () => {
      expect(AddShipmentLegsSchema.safeParse({ legs: [] }).success).toBe(false);
    });
  });

  describe("ShipmentLegAssignmentSchema", () => {
    it("accepts attaching an engagement ID", () => {
      const parsed = ShipmentLegAssignmentSchema.safeParse({
        expectedVersion: 0,
        logisticsEngagementId: "eng_123",
      });
      expect(parsed.success).toBe(true);
    });

    it("accepts explicit null for detaching engagement", () => {
      const parsed = ShipmentLegAssignmentSchema.safeParse({
        expectedVersion: 1,
        logisticsEngagementId: null,
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects missing logisticsEngagementId (requires explicit null or string)", () => {
      expect(
        ShipmentLegAssignmentSchema.safeParse({
          expectedVersion: 0,
        }).success,
      ).toBe(false);
    });
  });

  describe("ShipmentLegCommandSchema (Discriminated Union)", () => {
    it("validates 'book' command", () => {
      const parsed = ShipmentLegCommandSchema.safeParse({
        command: "book",
        expectedVersion: 0,
        carrierReference: "MAEU123456",
        trackingReference: "TRACK-999",
      });
      expect(parsed.success).toBe(true);
    });

    it("validates 'depart' command", () => {
      const parsed = ShipmentLegCommandSchema.safeParse({
        command: "depart",
        expectedVersion: 1,
        locationIdentifier: "INBOM",
      });
      expect(parsed.success).toBe(true);
    });

    it("validates 'arrive' command", () => {
      const parsed = ShipmentLegCommandSchema.safeParse({
        command: "arrive",
        expectedVersion: 2,
        locationIdentifier: "USLAX",
      });
      expect(parsed.success).toBe(true);
    });

    it("validates 'complete' command", () => {
      const parsed = ShipmentLegCommandSchema.safeParse({
        command: "complete",
        expectedVersion: 3,
        note: "Delivered to customs warehouse.",
      });
      expect(parsed.success).toBe(true);
    });

    it("validates 'report_exception' command with mandatory description", () => {
      const parsed = ShipmentLegCommandSchema.safeParse({
        command: "report_exception",
        expectedVersion: 4,
        description: "Port congestion delay of 48h.",
      });
      expect(parsed.success).toBe(true);

      expect(
        ShipmentLegCommandSchema.safeParse({
          command: "report_exception",
          expectedVersion: 4,
        }).success,
      ).toBe(false);
    });

    it("validates 'cancel' command", () => {
      const parsed = ShipmentLegCommandSchema.safeParse({
        command: "cancel",
        expectedVersion: 0,
        note: "Booking revoked by consignee.",
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects unknown command variant", () => {
      expect(
        ShipmentLegCommandSchema.safeParse({
          command: "unknown_action",
          expectedVersion: 0,
        }).success,
      ).toBe(false);
    });
  });

  describe("AppendShipmentEventSchema & ListShipmentsQuerySchema", () => {
    it("validates AppendShipmentEventSchema", () => {
      const parsed = AppendShipmentEventSchema.safeParse({
        eventKind: "in_transit",
        description: "Container discharged from vessel.",
      });
      expect(parsed.success).toBe(true);
    });

    it("validates ListShipmentsQuerySchema", () => {
      const data = ListShipmentsQuerySchema.parse({
        state: "in_transit",
        limit: "25",
      });
      expect(data.limit).toBe(25);
    });
  });
});
