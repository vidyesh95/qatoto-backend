import { describe, expect, it } from "vitest";

import {
  CreateBranchSchema,
  CreateOpportunitySchema,
  CreatePaperCategorySchema,
  CreatePaperSchema,
  CreatePostSchema,
  CreateProgramSchema,
  CreateReplySchema,
  CursorQuerySchema,
  DecidePaperCategorySchema,
  JoinProgramSchema,
  LogEffortSchema,
  ModeratePaperSchema,
  ModeratePostSchema,
  ModerateProgramSchema,
  PageQuerySchema,
  RecordContributionSchema,
  ReportContentSchema,
  UpdateBranchSchema,
  UpdateProgramSchema,
} from "./research-programs.schemas.js";

describe("research-programs.schemas", () => {
  describe("PageQuerySchema & CursorQuerySchema", () => {
    it("PageQuerySchema sets default page=1 and limit=20", () => {
      const data = PageQuerySchema.parse({});
      expect(data).toEqual({ page: 1, limit: 20 });
    });

    it("PageQuerySchema rejects non-positive page and limit > 100", () => {
      expect(PageQuerySchema.safeParse({ page: 0 }).success).toBe(false);
      expect(PageQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    });

    it("CursorQuerySchema parses valid cursor and limit", () => {
      const data = CursorQuerySchema.parse({ limit: "50", cursor: "cur_abc123" });
      expect(data).toEqual({ limit: 50, cursor: "cur_abc123" });
    });
  });

  describe("CreateProgramSchema & UpdateProgramSchema", () => {
    const valid = {
      title: "Project Immortal",
      tagline: "Cellular rejuvenation and longevity research foundry.",
      missionStatement:
        "Building an open-source biological repository and high-throughput screening engine for senescence clearing.",
    };

    it("accepts valid program creation payload", () => {
      const data = CreateProgramSchema.parse(valid);
      expect(data.title).toBe("Project Immortal");
    });

    it("rejects missionStatement shorter than 20 chars", () => {
      const parsed = CreateProgramSchema.safeParse({ ...valid, missionStatement: "Too short" });
      expect(parsed.success).toBe(false);
    });

    it("rejects unrecognized status field in CreateProgramSchema", () => {
      const parsed = CreateProgramSchema.safeParse({ ...valid, status: "published" });
      expect(parsed.success).toBe(false);
    });

    it("UpdateProgramSchema accepts partial fields", () => {
      const data = UpdateProgramSchema.parse({ tagline: "New tagline for the program" });
      expect(data.tagline).toBe("New tagline for the program");
    });
  });

  describe("ModerateProgramSchema", () => {
    it("accepts published decision with reviewerNote", () => {
      const data = ModerateProgramSchema.parse({
        decision: "published",
        reviewerNote: "Comprehensive research proposal verified by academic panel.",
      });
      expect(data.decision).toBe("published");
    });

    it("accepts rejected decision with reviewerNote", () => {
      const data = ModerateProgramSchema.parse({
        decision: "rejected",
        reviewerNote: "Lacks biological grounding and safety protocols.",
      });
      expect(data.decision).toBe("rejected");
    });

    it("rejects missing reviewerNote", () => {
      const parsed = ModerateProgramSchema.safeParse({ decision: "published" });
      expect(parsed.success).toBe(false);
    });
  });

  describe("CreateBranchSchema & UpdateBranchSchema", () => {
    it("accepts root branch creation with null parentBranchId default", () => {
      const data = CreateBranchSchema.parse({
        title: "Target Discovery",
        summary: "High-throughput genetic screen targeting senescent cells.",
      });
      expect(data.parentBranchId).toBeNull();
      expect(data.title).toBe("Target Discovery");
    });

    it("accepts sub-branch with parentBranchId", () => {
      const data = CreateBranchSchema.parse({
        title: "CRISPR Assays",
        summary: "Validating gRNA libraries for p16Ink4a locus knockout.",
        parentBranchId: "branch_target_disc",
      });
      expect(data.parentBranchId).toBe("branch_target_disc");
    });

    it("UpdateBranchSchema accepts pinned permille layout coordinates", () => {
      const data = UpdateBranchSchema.parse({
        pinnedLeftPermille: 450,
        pinnedTopPermille: 320,
        siblingOrder: 2,
      });
      expect(data.pinnedLeftPermille).toBe(450);
      expect(data.pinnedTopPermille).toBe(320);
    });

    it("UpdateBranchSchema rejects pinned permille above 1000", () => {
      const parsed = UpdateBranchSchema.safeParse({ pinnedLeftPermille: 1001 });
      expect(parsed.success).toBe(false);
    });
  });

  describe("CreatePaperSchema & ModeratePaperSchema", () => {
    const validPaper = {
      title: "Targeted Senolysis via Small Molecule Modulators",
      categoryId: "cat_longevity_01",
      doi: "10.1038/s41586-026-0001-x",
      abstractText: "We report the discovery of a novel class of compounds that induce apoptosis selectively.",
    };

    it("accepts valid paper metadata", () => {
      const data = CreatePaperSchema.parse(validPaper);
      expect(data.title).toBe(validPaper.title);
      expect(data.branchId).toBeNull();
    });

    it("rejects paper with title shorter than 3 chars", () => {
      const parsed = CreatePaperSchema.safeParse({ ...validPaper, title: "No" });
      expect(parsed.success).toBe(false);
    });

    it("ModeratePaperSchema accepts approved decision", () => {
      const data = ModeratePaperSchema.parse({
        decision: "approved",
        reviewerNote: "Clear experimental methodology and reproducibility.",
      });
      expect(data.decision).toBe("approved");
      expect(data.flagReasons).toEqual([]);
    });

    it("ModeratePaperSchema accepts needs_changes with flag reasons", () => {
      const data = ModeratePaperSchema.parse({
        decision: "needs_changes",
        reviewerNote: "Supplementary data figures are missing.",
        flagReasons: ["Missing Figure S1", "Raw count data absent"],
      });
      expect(data.flagReasons).toHaveLength(2);
    });
  });

  describe("CreatePaperCategorySchema & DecidePaperCategorySchema", () => {
    it("accepts valid category label", () => {
      const data = CreatePaperCategorySchema.parse({ label: "Molecular Biology" });
      expect(data.label).toBe("Molecular Biology");
    });

    it("DecidePaperCategorySchema accepts approve with optional note", () => {
      const data = DecidePaperCategorySchema.parse({ decision: "approve" });
      expect(data.decision).toBe("approve");
    });

    it("DecidePaperCategorySchema requires note when rejecting", () => {
      expect(DecidePaperCategorySchema.safeParse({ decision: "reject" }).success).toBe(false);
      const data = DecidePaperCategorySchema.parse({
        decision: "reject",
        note: "Overlaps with existing Cellular Senescence taxonomy.",
      });
      expect(data.decision).toBe("reject");
    });
  });

  describe("CreatePostSchema & CreateReplySchema", () => {
    it("accepts informal_paper with title and bodyText", () => {
      const data = CreatePostSchema.parse({
        track: "informal_paper",
        title: "Preliminary In-Vitro Results for Compound Q-42",
        bodyText: "Observed 85% viability clearance at 10nM concentration over 48 hours.",
      });
      expect(data.track).toBe("informal_paper");
      expect(data.title).toBe("Preliminary In-Vitro Results for Compound Q-42");
    });

    it("rejects informal_paper when title is null or missing", () => {
      const parsed = CreatePostSchema.safeParse({
        track: "informal_paper",
        bodyText: "Observed 85% viability clearance without title.",
      });
      expect(parsed.success).toBe(false);
    });

    it("accepts idea when title is null", () => {
      const data = CreatePostSchema.parse({
        track: "idea",
        title: null,
        bodyText: "Could microfluidic cell traps improve single-cell clearance throughput?",
      });
      expect(data.track).toBe("idea");
      expect(data.title).toBeNull();
    });

    it("rejects idea when title is provided", () => {
      const parsed = CreatePostSchema.safeParse({
        track: "idea",
        title: "Disallowed Title for Idea",
        bodyText: "Ideas must not have titles.",
      });
      expect(parsed.success).toBe(false);
    });

    it("CreateReplySchema accepts valid bodyText", () => {
      const data = CreateReplySchema.parse({ bodyText: "Agree, microfluidics would scale this well." });
      expect(data.bodyText).toBe("Agree, microfluidics would scale this well.");
    });
  });

  describe("ReportContentSchema & ModeratePostSchema", () => {
    it("accepts valid content report", () => {
      const data = ReportContentSchema.parse({ reason: "misinformation", detailText: "Fabricated assay data." });
      expect(data.reason).toBe("misinformation");
    });

    it("ModeratePostSchema accepts hidden verdict with reasonNote", () => {
      const data = ModeratePostSchema.parse({
        decision: "hidden",
        reasonNote: "Violates community guidelines on commercial solicitation.",
      });
      expect(data.decision).toBe("hidden");
    });
  });

  describe("JoinProgramSchema, LogEffortSchema, RecordContributionSchema", () => {
    it("JoinProgramSchema accepts participant details", () => {
      const data = JoinProgramSchema.parse({
        role: "researcher",
        compensationPreference: "equity",
        contributionSummary: "Leading in-vitro assay screen.",
      });
      expect(data.role).toBe("researcher");
      expect(data.compensationPreference).toBe("equity");
    });

    it("LogEffortSchema accepts daily minutes between 1 and 1440 and valid ISO date", () => {
      const data = LogEffortSchema.parse({
        minutes: 240,
        loggedForDate: "2026-06-12",
        note: "Ran fluorescence cell sorting and data analysis.",
        idempotencyKey: "effort_key_12345",
      });
      expect(data.minutes).toBe(240);
      expect(data.loggedForDate).toBe("2026-06-12");
    });

    it("LogEffortSchema rejects minutes exceeding 1440 (1 day)", () => {
      const parsed = LogEffortSchema.safeParse({
        minutes: 1441,
        loggedForDate: "2026-06-12",
        note: "Impossible day",
        idempotencyKey: "effort_key_12345",
      });
      expect(parsed.success).toBe(false);
    });

    it("RecordContributionSchema accepts decimal string amountInCents and 3-letter currencyCode", () => {
      const data = RecordContributionSchema.parse({
        kind: "cash_commitment",
        amountInCents: "25000000",
        currencyCode: "USD",
        description: "Seed grant for reagent procurement.",
        idempotencyKey: "contrib_key_12345",
      });
      expect(data.amountInCents).toBe("25000000");
      expect(data.currencyCode).toBe("USD");
    });
  });

  describe("CreateOpportunitySchema", () => {
    it("accepts valid product opportunity specification", () => {
      const data = CreateOpportunitySchema.parse({
        productName: "Immortal Screen v1 Reagent Kit",
        productDescription: "Commercial assay kit for multi-target senolytic profiling.",
        derivedFromBranchId: "branch_senolytics_01",
        estimatedMarketSizeInCents: "50000000000",
        readinessMinMonths: 12,
        readinessMaxMonths: 24,
      });
      expect(data.productName).toBe("Immortal Screen v1 Reagent Kit");
      expect(data.readinessMinMonths).toBe(12);
      expect(data.readinessMaxMonths).toBe(24);
    });
  });
});
