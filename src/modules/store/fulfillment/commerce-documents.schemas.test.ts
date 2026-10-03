import { describe, expect, it } from "vitest";

import {
  DocumentIdParamsSchema,
  EmptyObjectSchema,
  ListTradeDocumentsQuerySchema,
} from "./commerce-documents.schemas.js";

describe("commerce-documents.schemas", () => {
  describe("EmptyObjectSchema & DocumentIdParamsSchema", () => {
    it("validates empty object", () => {
      expect(EmptyObjectSchema.safeParse({}).success).toBe(true);
      expect(EmptyObjectSchema.safeParse({ key: "val" }).success).toBe(false);
    });

    it("validates DocumentIdParamsSchema", () => {
      expect(DocumentIdParamsSchema.safeParse({ documentId: "doc_123" }).success).toBe(true);
      expect(DocumentIdParamsSchema.safeParse({ documentId: "" }).success).toBe(false);
    });
  });

  describe("ListTradeDocumentsQuerySchema", () => {
    it("accepts empty query", () => {
      expect(ListTradeDocumentsQuerySchema.safeParse({}).success).toBe(true);
    });

    it("accepts valid cursor and limit with coercion up to 100", () => {
      const data = ListTradeDocumentsQuerySchema.parse({
        cursor: "cursor_token_123",
        limit: "20",
      });
      expect(data.cursor).toBe("cursor_token_123");
      expect(data.limit).toBe(20);
    });

    it("rejects limit > 100", () => {
      expect(ListTradeDocumentsQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    });

    it("rejects unknown query properties due to strict mode", () => {
      expect(
        ListTradeDocumentsQuerySchema.safeParse({
          documentType: "commercial_invoice",
        }).success,
      ).toBe(false);
    });
  });
});
