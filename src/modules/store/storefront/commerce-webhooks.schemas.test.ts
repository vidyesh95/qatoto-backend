import { describe, expect, it } from "vitest";

import { EmptyObjectSchema, ProviderIdParamsSchema, RazorpayWebhookBodySchema } from "./commerce-webhooks.schemas.js";

describe("commerce-webhooks.schemas", () => {
  describe("ProviderIdParamsSchema & EmptyObjectSchema", () => {
    it("validates empty object", () => {
      expect(EmptyObjectSchema.safeParse({}).success).toBe(true);
      expect(EmptyObjectSchema.safeParse({ extra: 1 }).success).toBe(false);
    });

    it("validates ProviderIdParamsSchema", () => {
      expect(ProviderIdParamsSchema.safeParse({ providerId: "razorpay" }).success).toBe(true);
      expect(ProviderIdParamsSchema.safeParse({ providerId: "" }).success).toBe(false);
      expect(ProviderIdParamsSchema.safeParse({ providerId: "p".repeat(201) }).success).toBe(false);
    });
  });

  describe("RazorpayWebhookBodySchema", () => {
    it("validates order.paid webhook payload", () => {
      const payload = {
        event: "order.paid",
        payload: {
          order: {
            entity: {
              id: "order_EKwxwAgItmmXdp",
            },
          },
        },
      };
      const data = RazorpayWebhookBodySchema.parse(payload);
      expect(data.payload.order?.entity.id).toBe("order_EKwxwAgItmmXdp");
    });

    it("validates payment.captured webhook payload", () => {
      const payload = {
        event: "payment.captured",
        payload: {
          payment: {
            entity: {
              order_id: "order_EKwxwAgItmmXdp",
            },
          },
        },
      };
      const data = RazorpayWebhookBodySchema.parse(payload);
      expect(data.payload.payment?.entity.order_id).toBe("order_EKwxwAgItmmXdp");
    });

    it("accepts unexpected additional fields because it is not strict (Razorpay forward-compatibility)", () => {
      const payload = {
        event: "order.paid",
        payload: {
          order: {
            entity: {
              id: "order_123",
              extra_razorpay_field: "ignored",
            },
          },
        },
      };
      expect(RazorpayWebhookBodySchema.safeParse(payload).success).toBe(true);
    });

    it("rejects empty event name", () => {
      expect(
        RazorpayWebhookBodySchema.safeParse({
          event: "",
          payload: {},
        }).success,
      ).toBe(false);
    });
  });
});
