import { describe, expect, it } from "vitest";

import {
  StoreOrganizationReviewParamsSchema,
  StoreProductReviewParamsSchema,
  StoreReviewListQuerySchema,
} from "./store-reviews.schemas.js";

describe("store-reviews.schemas", () => {
  describe("StoreReviewListQuerySchema", () => {
    it("applies defaults on empty query", () => {
      const data = StoreReviewListQuerySchema.parse({});
      expect(data.sort).toBe("recent");
      expect(data.limit).toBe(12);
      expect(data.hasMedia).toBeUndefined();
      expect(data.unreplied).toBeUndefined();
    });

    it("transforms boolean string filters correctly", () => {
      const trueData = StoreReviewListQuerySchema.parse({
        hasMedia: "true",
        unreplied: "true",
      });
      expect(trueData.hasMedia).toBe(true);
      expect(trueData.unreplied).toBe(true);

      const falseData = StoreReviewListQuerySchema.parse({
        hasMedia: "false",
        unreplied: "false",
      });
      expect(falseData.hasMedia).toBe(false);
      expect(falseData.unreplied).toBe(false);
    });

    it("rejects non-boolean strings for hasMedia and unreplied", () => {
      expect(StoreReviewListQuerySchema.safeParse({ hasMedia: "1" }).success).toBe(false);
      expect(StoreReviewListQuerySchema.safeParse({ unreplied: "yes" }).success).toBe(false);
    });

    it("rejects limit > 24", () => {
      expect(StoreReviewListQuerySchema.safeParse({ limit: 25 }).success).toBe(false);
    });
  });

  describe("Params schemas", () => {
    it("validates StoreProductReviewParamsSchema and StoreOrganizationReviewParamsSchema", () => {
      expect(StoreProductReviewParamsSchema.safeParse({ productSlug: "prod-slug" }).success).toBe(true);
      expect(StoreProductReviewParamsSchema.safeParse({ productSlug: "" }).success).toBe(false);

      expect(StoreOrganizationReviewParamsSchema.safeParse({ organizationSlug: "org-slug" }).success).toBe(true);
      expect(StoreOrganizationReviewParamsSchema.safeParse({ organizationSlug: "" }).success).toBe(false);
    });
  });
});
