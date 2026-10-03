import { describe, expect, it } from "vitest";

import {
  EmptyObjectSchema,
  ModerateRankingBodySchema,
  ProductIdParamsSchema,
} from "#src/modules/store/catalog/commerce-ranking.schemas.js";

describe("commerce-ranking.schemas", () => {
  describe("EmptyObjectSchema", () => {
    it("accepts empty object", () => {
      expect(EmptyObjectSchema.parse({})).toEqual({});
    });

    it("rejects non-empty object", () => {
      expect(EmptyObjectSchema.safeParse({ extra: 1 }).success).toBe(false);
    });
  });

  describe("ProductIdParamsSchema", () => {
    it("accepts valid productId", () => {
      expect(ProductIdParamsSchema.parse({ productId: "prd_123" }).productId).toBe("prd_123");
    });

    it("rejects empty productId", () => {
      expect(ProductIdParamsSchema.safeParse({ productId: "   " }).success).toBe(false);
    });
  });

  describe("ModerateRankingBodySchema", () => {
    it("accepts valid actions and reasons", () => {
      const actions = ["none", "weight_reduced", "capped", "quarantined", "review_queued"] as const;

      for (const action of actions) {
        const parsed = ModerateRankingBodySchema.parse({
          action,
          reason: "Suspicious sudden increase in bookmarks",
        });
        expect(parsed.action).toBe(action);
      }
    });

    it("rejects reasons that are too short", () => {
      expect(
        ModerateRankingBodySchema.safeParse({
          action: "capped",
          reason: "no",
        }).success,
      ).toBe(false);
    });

    it("rejects unknown action", () => {
      expect(
        ModerateRankingBodySchema.safeParse({
          action: "banned",
          reason: "Not a valid action enum",
        }).success,
      ).toBe(false);
    });
  });
});
