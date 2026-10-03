import { describe, expect, it } from "vitest";

import {
  AddDisputeNoteSchema,
  AttachReviewVideoSchema,
  CompletionIdParamsSchema,
  CreateDisputeSchema,
  CreateReviewSchema,
  DecideDisputeSchema,
  DisputeIdParamsSchema,
  EditOwnReviewSchema,
  EmptyObjectSchema,
  ListBuyerCompletionsQuerySchema,
  ListDisputesQuerySchema,
  OrderIdParamsSchema,
  ReviewIdParamsSchema,
  ReviewMediaParamsSchema,
  UpsertReviewReplySchema,
} from "./commerce-trust.schemas.js";

describe("commerce-trust.schemas", () => {
  describe("Review creation & editing", () => {
    it("accepts valid review creation without scores", () => {
      const parsed = CreateReviewSchema.safeParse({
        rating: 5,
        body: "Exceptional precision and robust build quality.",
      });
      expect(parsed.success).toBe(true);
    });

    it("accepts valid review creation with sub-scores", () => {
      const parsed = CreateReviewSchema.safeParse({
        rating: 4,
        body: "Great quality, slightly longer shipping.",
        scores: {
          quality: 5,
          shipping: 3,
        },
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects empty scores object if scores key is present", () => {
      const parsed = CreateReviewSchema.safeParse({
        rating: 4,
        body: "Text",
        scores: {},
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects invalid rating outside 1..5", () => {
      expect(CreateReviewSchema.safeParse({ rating: 0, body: "Bad" }).success).toBe(false);
      expect(CreateReviewSchema.safeParse({ rating: 6, body: "Good" }).success).toBe(false);
    });

    it("validates EditOwnReviewSchema (requires rating and body)", () => {
      const parsed = EditOwnReviewSchema.safeParse({
        rating: 5,
        body: "Updated review text after 2 weeks of use.",
      });
      expect(parsed.success).toBe(true);

      expect(EditOwnReviewSchema.safeParse({ body: "Only body" }).success).toBe(false);
    });

    it("validates AttachReviewVideoSchema", () => {
      expect(
        AttachReviewVideoSchema.safeParse({
          youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        }).success,
      ).toBe(true);

      expect(AttachReviewVideoSchema.safeParse({ youtubeUrl: "" }).success).toBe(false);
    });

    it("validates UpsertReviewReplySchema", () => {
      expect(UpsertReviewReplySchema.safeParse({ body: "Thank you for your feedback!" }).success).toBe(true);
      expect(UpsertReviewReplySchema.safeParse({ body: "" }).success).toBe(false);
    });
  });

  describe("Disputes & Resolutions", () => {
    it("validates CreateDisputeSchema", () => {
      const parsed = CreateDisputeSchema.safeParse({
        reasonCode: "goods_damaged_in_transit",
        summary: "30 cartons arrived with severe water intrusion.",
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects invalid reasonCode format", () => {
      expect(
        CreateDisputeSchema.safeParse({
          reasonCode: "Invalid-Reason-Code!",
          summary: "Summary",
        }).success,
      ).toBe(false);
    });

    it("validates DecideDisputeSchema", () => {
      expect(DecideDisputeSchema.safeParse({ decision: "closed", note: "Resolved by settlement." }).success).toBe(true);
      expect(DecideDisputeSchema.safeParse({ decision: "dismissed" }).success).toBe(true);
      expect(DecideDisputeSchema.safeParse({ decision: "rejected" }).success).toBe(false);
    });

    it("validates AddDisputeNoteSchema", () => {
      expect(AddDisputeNoteSchema.safeParse({ note: "Carrier claims inspection report pending." }).success).toBe(true);
      expect(AddDisputeNoteSchema.safeParse({ note: "" }).success).toBe(false);
    });
  });

  describe("Params & Queries", () => {
    it("validates ID params and empty schemas", () => {
      expect(EmptyObjectSchema.safeParse({}).success).toBe(true);
      expect(ReviewIdParamsSchema.safeParse({ reviewId: "rev_1" }).success).toBe(true);
      expect(ReviewMediaParamsSchema.safeParse({ reviewId: "rev_1", mediaId: "med_1" }).success).toBe(true);
      expect(CompletionIdParamsSchema.safeParse({ completionId: "comp_1" }).success).toBe(true);
      expect(OrderIdParamsSchema.safeParse({ orderId: "ord_1" }).success).toBe(true);
      expect(DisputeIdParamsSchema.safeParse({ disputeId: "disp_1" }).success).toBe(true);
    });

    it("validates ListDisputesQuerySchema", () => {
      const parsed = ListDisputesQuerySchema.safeParse({
        state: "open",
        limit: "20",
      });
      expect(parsed.success).toBe(true);
    });

    it("validates ListBuyerCompletionsQuerySchema reviewable filter", () => {
      const trueData = ListBuyerCompletionsQuerySchema.parse({ reviewable: "true" });
      expect(trueData.reviewable).toBe(true);

      const falseData = ListBuyerCompletionsQuerySchema.parse({ reviewable: "false" });
      expect(falseData.reviewable).toBe(false);
    });
  });
});
