import { describe, expect, it } from "vitest";

import {
  CreatePitchSchema,
  ListMyPitchesQuerySchema,
  ListPublicPitchesQuerySchema,
  ModeratePitchSchema,
  PitchPageQuerySchema,
  RecordPitchOutcomeSchema,
  UpdatePitchSchema,
} from "./pitches.schemas.js";

describe("pitches.schemas", () => {
  describe("PitchPageQuerySchema", () => {
    it("applies defaults when empty", () => {
      const data = PitchPageQuerySchema.parse({});
      expect(data).toEqual({ page: 1, limit: 25 });
    });

    it("coerces string page and limit", () => {
      const data = PitchPageQuerySchema.parse({ page: "3", limit: "50" });
      expect(data).toEqual({ page: 3, limit: 50 });
    });

    it("rejects non-positive page", () => {
      const parsed = PitchPageQuerySchema.safeParse({ page: 0 });
      expect(parsed.success).toBe(false);
    });

    it("rejects limit over 100", () => {
      const parsed = PitchPageQuerySchema.safeParse({ limit: 101 });
      expect(parsed.success).toBe(false);
    });
  });

  describe("CreatePitchSchema", () => {
    const valid = {
      title: "Clean Water Drone Fleet",
      summary: "Autonomous drone network delivering portable water filtration pods to flood zones.",
    };

    it("accepts valid minimal pitch", () => {
      const data = CreatePitchSchema.parse(valid);
      expect(data).toEqual(valid);
    });

    it("accepts valid full pitch", () => {
      const full = {
        ...valid,
        pitchVideoId: "vid_12345",
        externalFundingUrl: "https://crowdfund.example.com/clean-water",
        externalContactUrl: "https://contact.example.com/founder",
      };
      const data = CreatePitchSchema.parse(full);
      expect(data.pitchVideoId).toBe("vid_12345");
      expect(data.externalFundingUrl).toBe("https://crowdfund.example.com/clean-water");
    });

    it("rejects title shorter than 3 characters", () => {
      const parsed = CreatePitchSchema.safeParse({ ...valid, title: "No" });
      expect(parsed.success).toBe(false);
    });

    it("rejects title longer than 120 characters", () => {
      const parsed = CreatePitchSchema.safeParse({ ...valid, title: "a".repeat(121) });
      expect(parsed.success).toBe(false);
    });

    it("rejects summary shorter than 20 characters", () => {
      const parsed = CreatePitchSchema.safeParse({ ...valid, summary: "Too short summary" });
      expect(parsed.success).toBe(false);
    });

    it("rejects unrecognized extra fields due to strict mode", () => {
      const parsed = CreatePitchSchema.safeParse({ ...valid, status: "published" });
      expect(parsed.success).toBe(false);
    });
  });

  describe("UpdatePitchSchema", () => {
    it("accepts empty object (all fields optional)", () => {
      const data = UpdatePitchSchema.parse({});
      expect(data).toEqual({});
    });

    it("accepts null for clearable fields", () => {
      const data = UpdatePitchSchema.parse({
        pitchVideoId: null,
        externalFundingUrl: null,
        externalContactUrl: null,
      });
      expect(data.pitchVideoId).toBeNull();
      expect(data.externalFundingUrl).toBeNull();
      expect(data.externalContactUrl).toBeNull();
    });

    it("rejects invalid title length", () => {
      const parsed = UpdatePitchSchema.safeParse({ title: "ab" });
      expect(parsed.success).toBe(false);
    });

    it("rejects unrecognized properties", () => {
      const parsed = UpdatePitchSchema.safeParse({ slug: "new-slug" });
      expect(parsed.success).toBe(false);
    });
  });

  describe("ModeratePitchSchema", () => {
    it("accepts published verdict without reason", () => {
      const data = ModeratePitchSchema.parse({ decision: "published" });
      expect(data.decision).toBe("published");
    });

    it("rejects published verdict if reason is provided", () => {
      const parsed = ModeratePitchSchema.safeParse({
        decision: "published",
        reason: "Looks great to publish",
      });
      expect(parsed.success).toBe(false);
    });

    it("accepts rejected verdict with valid reason", () => {
      const data = ModeratePitchSchema.parse({
        decision: "rejected",
        reason: "External funding link is broken and unreachable.",
      });
      expect(data.decision).toBe("rejected");
    });

    it("rejects rejected verdict missing reason", () => {
      const parsed = ModeratePitchSchema.safeParse({ decision: "rejected" });
      expect(parsed.success).toBe(false);
    });

    it("rejects rejected verdict with reason shorter than 10 characters", () => {
      const parsed = ModeratePitchSchema.safeParse({
        decision: "rejected",
        reason: "Bad link",
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe("RecordPitchOutcomeSchema", () => {
    const valid = {
      amountInCents: "5000000",
      currencyCode: "usd",
      fundedOnDate: "2026-05-15",
      funderNameText: "Acme Ventures",
      idempotencyKey: "idem_key_12345",
    };

    it("accepts valid outcome and transforms currencyCode to uppercase", () => {
      const data = RecordPitchOutcomeSchema.parse(valid);
      expect(data.currencyCode).toBe("USD");
      expect(data.amountInCents).toBe("5000000");
      expect(data.fundedOnDate).toBe("2026-05-15");
    });

    it("rejects zero amount in cents", () => {
      const parsed = RecordPitchOutcomeSchema.safeParse({ ...valid, amountInCents: "0" });
      expect(parsed.success).toBe(false);
    });

    it("rejects negative or decimal amount in cents", () => {
      expect(RecordPitchOutcomeSchema.safeParse({ ...valid, amountInCents: "-500" }).success).toBe(false);
      expect(RecordPitchOutcomeSchema.safeParse({ ...valid, amountInCents: "50.5" }).success).toBe(false);
    });

    it("rejects invalid ISO-4217 currency code", () => {
      expect(RecordPitchOutcomeSchema.safeParse({ ...valid, currencyCode: "US" }).success).toBe(false);
      expect(RecordPitchOutcomeSchema.safeParse({ ...valid, currencyCode: "USDT" }).success).toBe(false);
    });

    it("rejects invalid date format", () => {
      const parsed = RecordPitchOutcomeSchema.safeParse({ ...valid, fundedOnDate: "15-05-2026" });
      expect(parsed.success).toBe(false);
    });

    it("rejects idempotency key shorter than 8 characters", () => {
      const parsed = RecordPitchOutcomeSchema.safeParse({ ...valid, idempotencyKey: "short" });
      expect(parsed.success).toBe(false);
    });

    it("rejects missing funderNameText", () => {
      const { funderNameText: _, ...rest } = valid;
      const parsed = RecordPitchOutcomeSchema.safeParse(rest);
      expect(parsed.success).toBe(false);
    });
  });

  describe("ListPublicPitchesQuerySchema & ListMyPitchesQuerySchema", () => {
    it("accepts valid public pitches query with optional projectSlug", () => {
      const data = ListPublicPitchesQuerySchema.parse({
        page: "2",
        limit: "10",
        projectSlug: "clean-water-project",
      });
      expect(data).toEqual({
        page: 2,
        limit: 10,
        projectSlug: "clean-water-project",
      });
    });

    it("rejects status filter in public pitches query", () => {
      const parsed = ListPublicPitchesQuerySchema.safeParse({ status: "pending" });
      expect(parsed.success).toBe(false);
    });

    it("accepts valid status in my pitches query", () => {
      const data = ListMyPitchesQuerySchema.parse({ status: "pending" });
      expect(data.status).toBe("pending");
    });

    it("rejects invalid status in my pitches query", () => {
      const parsed = ListMyPitchesQuerySchema.safeParse({ status: "unknown_status" });
      expect(parsed.success).toBe(false);
    });
  });
});
