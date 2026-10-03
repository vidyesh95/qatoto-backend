import { describe, expect, it } from "vitest";

import {
  CreateContentReportSchema,
  DecideContentReportSchema,
  EmptyObjectSchema,
  ListContentReportsQuerySchema,
  ListWithdrawnProductAnswersQuerySchema,
  ReportIdParamsSchema,
  RestoreContentSchema,
} from "./commerce-content-reports.schemas.js";

describe("commerce-content-reports.schemas", () => {
  describe("Create & Decide Reports", () => {
    it("validates CreateContentReportSchema", () => {
      const parsed = CreateContentReportSchema.safeParse({
        targetKind: "product",
        targetId: "prod_123",
        reason: "counterfeit",
        detailText: "Unauthorized trademark replication on chassis.",
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects invalid targetKind or reason", () => {
      expect(
        CreateContentReportSchema.safeParse({
          targetKind: "user_account",
          targetId: "u_1",
          reason: "spam",
        }).success,
      ).toBe(false);

      expect(
        CreateContentReportSchema.safeParse({
          targetKind: "product",
          targetId: "prod_1",
          reason: "illegal_substance",
        }).success,
      ).toBe(false);
    });

    it("validates DecideContentReportSchema", () => {
      expect(DecideContentReportSchema.safeParse({ decision: "actioned", note: "Content hidden." }).success).toBe(true);
      expect(DecideContentReportSchema.safeParse({ decision: "dismissed" }).success).toBe(true);
      expect(DecideContentReportSchema.safeParse({ decision: "pending" }).success).toBe(false);
    });

    it("validates RestoreContentSchema (requires reasonNote)", () => {
      const parsed = RestoreContentSchema.safeParse({
        targetKind: "review",
        targetId: "rev_1",
        reasonNote: "Moderation mistake, authentic review verified.",
      });
      expect(parsed.success).toBe(true);

      expect(
        RestoreContentSchema.safeParse({
          targetKind: "review",
          targetId: "rev_1",
        }).success,
      ).toBe(false);
    });
  });

  describe("Params & Queries", () => {
    it("validates ReportIdParamsSchema and EmptyObjectSchema", () => {
      expect(EmptyObjectSchema.safeParse({}).success).toBe(true);
      expect(ReportIdParamsSchema.safeParse({ reportId: "rep_1" }).success).toBe(true);
      expect(ReportIdParamsSchema.safeParse({ reportId: "" }).success).toBe(false);
    });

    it("validates ListContentReportsQuerySchema", () => {
      const data = ListContentReportsQuerySchema.parse({
        status: "open",
        targetKind: "product",
        limit: "25",
      });
      expect(data.limit).toBe(25);
    });

    it("validates ListWithdrawnProductAnswersQuerySchema defaults", () => {
      const data = ListWithdrawnProductAnswersQuerySchema.parse({});
      expect(data.state).toBe("still_withdrawn");
      expect(data.limit).toBe(20);
    });
  });
});
