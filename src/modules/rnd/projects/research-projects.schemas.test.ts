import { describe, expect, it } from "vitest";

import {
  CreateProjectSchema,
  InsightIdParamSchema,
  LinkMarketInsightSchema,
  ListMyProjectsQuerySchema,
  ListProjectsQuerySchema,
  UpdateMemberSchema,
  UpdateProjectSchema,
  UpdateProjectStageSchema,
} from "#src/modules/rnd/projects/research-projects.schemas.js";

describe("research-projects.schemas", () => {
  describe("CreateProjectSchema", () => {
    const validMinimalPayload = {
      name: "Solar Desalination Kit",
      tagline: "Low-cost water desalination for coastal communities.",
      categoryId: "cat_energy_01",
    };

    it("accepts minimal valid creation payload", () => {
      const data = CreateProjectSchema.parse(validMinimalPayload);
      expect(data.name).toBe("Solar Desalination Kit");
      expect(data.tagline).toBe("Low-cost water desalination for coastal communities.");
      expect(data.categoryId).toBe("cat_energy_01");
    });

    it("accepts full payload with valid equity basis points band", () => {
      const fullPayload = {
        ...validMinimalPayload,
        description: "Full detailed project description.",
        problemStatement: "Lack of clean drinking water.",
        solutionSummary: "Compact thermal solar desalination.",
        targetRegion: "South Asia",
        demandEvidenceNotes: "Verified survey of 500 households.",
        seedRolesNeeded: ["Hardware Engineer", "Thermal Specialist"],
        offeredEquityBasisPointsMin: 500,
        offeredEquityBasisPointsMax: 1500,
        expectedCommitment: "part_time" as const,
      };

      const data = CreateProjectSchema.parse(fullPayload);
      expect(data.offeredEquityBasisPointsMin).toBe(500);
      expect(data.offeredEquityBasisPointsMax).toBe(1500);
      expect(data.expectedCommitment).toBe("part_time");
    });

    it("rejects inverted equity band (min > max)", () => {
      expect(() =>
        CreateProjectSchema.parse({
          ...validMinimalPayload,
          offeredEquityBasisPointsMin: 2000,
          offeredEquityBasisPointsMax: 1000,
        }),
      ).toThrow("The minimum offered equity cannot exceed the maximum.");
    });

    it("rejects negative or excessive (>10,000) equity basis points", () => {
      expect(
        CreateProjectSchema.safeParse({
          ...validMinimalPayload,
          offeredEquityBasisPointsMin: -10,
        }).success,
      ).toBe(false);

      expect(
        CreateProjectSchema.safeParse({
          ...validMinimalPayload,
          offeredEquityBasisPointsMax: 10_001,
        }).success,
      ).toBe(false);
    });

    it("rejects missing required fields (name, tagline, categoryId)", () => {
      expect(CreateProjectSchema.safeParse({ tagline: "Tag", categoryId: "c1" }).success).toBe(false);
      expect(CreateProjectSchema.safeParse({ name: "Name", categoryId: "c1" }).success).toBe(false);
      expect(CreateProjectSchema.safeParse({ name: "Name", tagline: "Tag" }).success).toBe(false);
    });

    it("rejects unexpected properties (.strict())", () => {
      expect(
        CreateProjectSchema.safeParse({
          ...validMinimalPayload,
          founderUserId: "usr_attacker",
        }).success,
      ).toBe(false);
    });
  });

  describe("UpdateProjectSchema", () => {
    it("accepts partial updates", () => {
      const data = UpdateProjectSchema.parse({
        tagline: "Updated concise tagline.",
      });
      expect(data.tagline).toBe("Updated concise tagline.");
    });

    it("rejects inverted equity band during partial update", () => {
      expect(() =>
        UpdateProjectSchema.parse({
          offeredEquityBasisPointsMin: 3000,
          offeredEquityBasisPointsMax: 1000,
        }),
      ).toThrow("The minimum offered equity cannot exceed the maximum.");
    });

    it("rejects unrecognized properties", () => {
      expect(
        UpdateProjectSchema.safeParse({
          status: "active",
        }).success,
      ).toBe(false);
    });
  });

  describe("UpdateProjectStageSchema", () => {
    it("accepts valid stage transition", () => {
      const data = UpdateProjectStageSchema.parse({
        stage: "building_mvp",
        note: "Completed prototyping phase.",
      });
      expect(data.stage).toBe("building_mvp");
      expect(data.note).toBe("Completed prototyping phase.");
    });

    it("rejects invalid stage outside enum", () => {
      expect(
        UpdateProjectStageSchema.safeParse({
          stage: "unicorn_ipo",
        }).success,
      ).toBe(false);
    });
  });

  describe("UpdateMemberSchema", () => {
    it("accepts maintainer and contributor roles", () => {
      expect(UpdateMemberSchema.parse({ projectRole: "maintainer" }).projectRole).toBe("maintainer");
      expect(UpdateMemberSchema.parse({ projectRole: "contributor" }).projectRole).toBe("contributor");
    });

    it("rejects founder and admin roles from being assigned via update", () => {
      expect(UpdateMemberSchema.safeParse({ projectRole: "founder" }).success).toBe(false);
      expect(UpdateMemberSchema.safeParse({ projectRole: "admin" }).success).toBe(false);
    });
  });

  describe("ListProjectsQuerySchema & ListMyProjectsQuerySchema", () => {
    it("coerces page and limit with default values", () => {
      const data = ListProjectsQuerySchema.parse({});
      expect(data.page).toBe(1);
      expect(data.limit).toBe(20);
    });

    it("accepts valid category and stage filters", () => {
      const data = ListProjectsQuerySchema.parse({
        category: "robotics",
        stage: "team_building",
        page: "2",
        limit: "50",
      });
      expect(data.category).toBe("robotics");
      expect(data.stage).toBe("team_building");
      expect(data.page).toBe(2);
      expect(data.limit).toBe(50);
    });

    it("rejects limit greater than 100", () => {
      expect(ListProjectsQuerySchema.safeParse({ limit: "150" }).success).toBe(false);
    });

    it("validates status in ListMyProjectsQuerySchema", () => {
      expect(ListMyProjectsQuerySchema.parse({ status: "active" }).status).toBe("active");
      expect(ListMyProjectsQuerySchema.safeParse({ status: "deleted" }).success).toBe(false);
    });
  });

  describe("LinkMarketInsightSchema & InsightIdParamSchema", () => {
    const validUuid = "123e4567-e89b-12d3-a456-426614174000";

    it("accepts a well-formed UUID", () => {
      expect(LinkMarketInsightSchema.parse({ insightId: validUuid }).insightId).toBe(validUuid);
      expect(InsightIdParamSchema.parse({ insightId: validUuid }).insightId).toBe(validUuid);
    });

    it("rejects non-UUID strings to prevent malformed round-trips to DB", () => {
      expect(LinkMarketInsightSchema.safeParse({ insightId: "not-a-uuid" }).success).toBe(false);
      expect(InsightIdParamSchema.safeParse({ insightId: "12345" }).success).toBe(false);
    });
  });
});
