import { describe, expect, it } from "vitest";

import {
  AnswerProductQuestionSchema,
  AskProductQuestionSchema,
  EmptyObjectSchema,
  ProductAnswerIdParamsSchema,
  ProductAnswerListParamsSchema,
  ProductIdParamsSchema,
  ProductQuestionIdParamsSchema,
  ProductQuestionListParamsSchema,
  ProductQuestionListQuerySchema,
  SellerQuestionInboxQuerySchema,
} from "./commerce-product-qa.schemas.js";

describe("commerce-product-qa.schemas", () => {
  describe("Ask & Answer schemas", () => {
    it("validates AskProductQuestionSchema", () => {
      const parsed = AskProductQuestionSchema.safeParse({
        bodyText: "What is the lead time for 5,000 units with custom packaging?",
      });
      expect(parsed.success).toBe(true);

      expect(AskProductQuestionSchema.safeParse({ bodyText: "" }).success).toBe(false);
      expect(AskProductQuestionSchema.safeParse({ bodyText: "a".repeat(1001) }).success).toBe(false);
    });

    it("validates AnswerProductQuestionSchema", () => {
      const parsed = AnswerProductQuestionSchema.safeParse({
        bodyText: "Our standard lead time is 18 calendar days.",
      });
      expect(parsed.success).toBe(true);

      expect(AnswerProductQuestionSchema.safeParse({ bodyText: "" }).success).toBe(false);
      expect(AnswerProductQuestionSchema.safeParse({ bodyText: "a".repeat(4001) }).success).toBe(false);
    });
  });

  describe("ID Params schemas", () => {
    it("validates empty object", () => {
      expect(EmptyObjectSchema.safeParse({}).success).toBe(true);
      expect(EmptyObjectSchema.safeParse({ extra: 1 }).success).toBe(false);
    });

    it("validates ProductIdParamsSchema", () => {
      expect(ProductIdParamsSchema.safeParse({ productId: "prod_1" }).success).toBe(true);
      expect(ProductIdParamsSchema.safeParse({ productId: "" }).success).toBe(false);
    });

    it("validates ProductQuestionIdParamsSchema and ProductAnswerIdParamsSchema", () => {
      expect(ProductQuestionIdParamsSchema.safeParse({ questionId: "q_1" }).success).toBe(true);
      expect(ProductAnswerIdParamsSchema.safeParse({ answerId: "ans_1" }).success).toBe(true);
    });

    it("validates ProductQuestionListParamsSchema and ProductAnswerListParamsSchema", () => {
      expect(ProductQuestionListParamsSchema.safeParse({ productSlug: "custom-enclosure" }).success).toBe(true);
      expect(
        ProductAnswerListParamsSchema.safeParse({ productSlug: "custom-enclosure", questionId: "q_1" }).success,
      ).toBe(true);
    });
  });

  describe("Query schemas", () => {
    it("validates ProductQuestionListQuerySchema defaults and bounds (max 24)", () => {
      const data = ProductQuestionListQuerySchema.parse({});
      expect(data.limit).toBe(12);

      expect(ProductQuestionListQuerySchema.safeParse({ limit: 24 }).success).toBe(true);
      expect(ProductQuestionListQuerySchema.safeParse({ limit: 25 }).success).toBe(false);
    });

    it("validates SellerQuestionInboxQuerySchema boolean transform and limit up to 100", () => {
      const trueData = SellerQuestionInboxQuerySchema.parse({
        unansweredOnly: "true",
        limit: "50",
      });
      expect(trueData.unansweredOnly).toBe(true);
      expect(trueData.limit).toBe(50);

      const falseData = SellerQuestionInboxQuerySchema.parse({ unansweredOnly: "false" });
      expect(falseData.unansweredOnly).toBe(false);

      expect(SellerQuestionInboxQuerySchema.safeParse({ unansweredOnly: "invalid" }).success).toBe(false);
      expect(SellerQuestionInboxQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    });
  });
});
