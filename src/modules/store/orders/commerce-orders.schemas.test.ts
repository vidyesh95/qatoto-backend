import { describe, expect, it } from "vitest";

import {
  ArrivalWindowQuerySchema,
  EmptyObjectSchema,
  EmptyRequestBodySchema,
  ListQuerySchema,
  OrderIdParamsSchema,
} from "./commerce-orders.schemas.js";

describe("commerce-orders.schemas", () => {
  describe("EmptyObjectSchema & EmptyRequestBodySchema", () => {
    it("accepts empty object and undefined", () => {
      expect(EmptyObjectSchema.safeParse({}).success).toBe(true);
      expect(EmptyRequestBodySchema.safeParse(undefined).success).toBe(true);
      expect(EmptyRequestBodySchema.safeParse({}).success).toBe(true);
    });

    it("rejects non-empty object", () => {
      expect(EmptyObjectSchema.safeParse({ unexpected: 123 }).success).toBe(false);
      expect(EmptyRequestBodySchema.safeParse({ unexpected: 123 }).success).toBe(false);
    });
  });

  describe("OrderIdParamsSchema", () => {
    it("validates valid orderId", () => {
      const data = OrderIdParamsSchema.parse({ orderId: "ord_12345" });
      expect(data.orderId).toBe("ord_12345");
    });

    it("rejects empty or whitespace-only orderId", () => {
      expect(OrderIdParamsSchema.safeParse({ orderId: "" }).success).toBe(false);
      expect(OrderIdParamsSchema.safeParse({ orderId: "   " }).success).toBe(false);
    });

    it("rejects orderId exceeding 200 characters", () => {
      expect(OrderIdParamsSchema.safeParse({ orderId: "o".repeat(201) }).success).toBe(false);
    });

    it("rejects unknown parameters in strict mode", () => {
      expect(OrderIdParamsSchema.safeParse({ orderId: "ord_1", extra: true }).success).toBe(false);
    });
  });

  describe("ArrivalWindowQuerySchema", () => {
    it("accepts empty query (mode omitted)", () => {
      const data = ArrivalWindowQuerySchema.parse({});
      expect(data.mode).toBeUndefined();
    });

    it("accepts valid freight mode values", () => {
      for (const mode of ["air", "sea", "land", "rail"] as const) {
        const data = ArrivalWindowQuerySchema.parse({ mode });
        expect(data.mode).toBe(mode);
      }
    });

    it("rejects invalid freight mode values", () => {
      expect(ArrivalWindowQuerySchema.safeParse({ mode: "rocket" }).success).toBe(false);
      expect(ArrivalWindowQuerySchema.safeParse({ mode: "multimodal" }).success).toBe(false);
    });

    it("rejects unexpected keys in strict mode", () => {
      expect(ArrivalWindowQuerySchema.safeParse({ mode: "air", extra: 1 }).success).toBe(false);
    });
  });

  describe("ListQuerySchema", () => {
    it("accepts empty object and leaves fields undefined", () => {
      const data = ListQuerySchema.parse({});
      expect(data.state).toBeUndefined();
      expect(data.limit).toBeUndefined();
      expect(data.cursor).toBeUndefined();
    });

    it("accepts valid enum states", () => {
      const validStates = [
        "pending_payment",
        "payment_processing",
        "confirmed",
        "in_fulfillment",
        "partially_completed",
        "completed",
        "cancelled",
        "disputed",
      ] as const;

      for (const state of validStates) {
        const data = ListQuerySchema.parse({ state });
        expect(data.state).toBe(state);
      }
    });

    it("rejects invalid state", () => {
      expect(ListQuerySchema.safeParse({ state: "refunded" }).success).toBe(false);
      expect(ListQuerySchema.safeParse({ state: "unknown" }).success).toBe(false);
    });

    it("coerces limit and enforces range 1..50", () => {
      expect(ListQuerySchema.parse({ limit: "1" }).limit).toBe(1);
      expect(ListQuerySchema.parse({ limit: "50" }).limit).toBe(50);
      expect(ListQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
      expect(ListQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
    });

    it("validates cursor bounds (min 1, max 500)", () => {
      expect(ListQuerySchema.safeParse({ cursor: "valid_cursor" }).success).toBe(true);
      expect(ListQuerySchema.safeParse({ cursor: "" }).success).toBe(false);
      expect(ListQuerySchema.safeParse({ cursor: "c".repeat(501) }).success).toBe(false);
    });

    it("rejects unknown query keys", () => {
      expect(ListQuerySchema.safeParse({ unexpected: true }).success).toBe(false);
    });
  });
});
