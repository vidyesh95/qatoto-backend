import { describe, expect, it } from "vitest";

import {
  AppendMessageBodySchema,
  CreateThreadBodySchema,
  ListMessagesQuerySchema,
  ListThreadsQuerySchema,
  ThreadParamsSchema,
} from "./commerce-messages.schemas.js";

describe("commerce-messages.schemas", () => {
  describe("CreateThreadBodySchema & ThreadParamsSchema", () => {
    it("validates thread creation for allowed resource kinds", () => {
      expect(
        CreateThreadBodySchema.safeParse({
          resourceKind: "rfq",
          resourceId: "rfq_123",
        }).success,
      ).toBe(true);

      expect(
        CreateThreadBodySchema.safeParse({
          resourceKind: "quote",
          resourceId: "q_123",
        }).success,
      ).toBe(true);
    });

    it("rejects unsupported resource kinds in create thread body", () => {
      expect(
        CreateThreadBodySchema.safeParse({
          resourceKind: "order",
          resourceId: "ord_123",
        }).success,
      ).toBe(false);
    });

    it("validates ThreadParamsSchema", () => {
      expect(ThreadParamsSchema.safeParse({ threadId: "thr_123" }).success).toBe(true);
      expect(ThreadParamsSchema.safeParse({ threadId: "" }).success).toBe(false);
    });
  });

  describe("List queries", () => {
    it("validates ListMessagesQuerySchema", () => {
      const data = ListMessagesQuerySchema.parse({
        limit: "50",
        cursor: "cursor_token",
      });
      expect(data.limit).toBe(50);
    });

    it("validates ListThreadsQuerySchema with allowed conversation family kinds", () => {
      for (const resourceKind of ["rfq", "quote", "product_inquiry", "manufacturing_inquiry"] as const) {
        const parsed = ListThreadsQuerySchema.safeParse({ resourceKind });
        expect(parsed.success).toBe(true);
      }

      expect(ListThreadsQuerySchema.safeParse({ resourceKind: "order" }).success).toBe(false);
    });
  });

  describe("AppendMessageBodySchema", () => {
    it("accepts valid message body with document IDs", () => {
      const parsed = AppendMessageBodySchema.safeParse({
        bodyText: "Please find the revised technical drawing attached.",
        encryptedDocumentIds: ["doc_123", "doc_456"],
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects empty bodyText", () => {
      expect(AppendMessageBodySchema.safeParse({ bodyText: "" }).success).toBe(false);
    });

    it("rejects bodyText exceeding 10,000 characters", () => {
      expect(AppendMessageBodySchema.safeParse({ bodyText: "a".repeat(10_001) }).success).toBe(false);
    });

    it("rejects more than 20 encryptedDocumentIds", () => {
      const docIds = Array.from({ length: 21 }, (_, i) => `doc_${i}`);
      expect(AppendMessageBodySchema.safeParse({ bodyText: "Hello", encryptedDocumentIds: docIds }).success).toBe(
        false,
      );
    });
  });
});
