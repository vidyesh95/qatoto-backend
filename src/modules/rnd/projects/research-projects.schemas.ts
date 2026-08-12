/**
 * Request schemas for research-projects, extracted from research-projects.controller.ts.
 *
 * WHY THESE ARE NOT IN THE CONTROLLER. They were the larger half of it — the handlers
 * did not begin until the file was already hundreds of lines deep — and they have a
 * second consumer that a controller cannot serve: `src/docs/openapi-rnd-bodies.ts`
 * generates request bodies from these schemas, and importing a controller to reach one
 * drags in its whole service and db graph.
 *
 * NOTHING ABOUT THE PARSE BOUNDARY MOVED. The controller imports these and every handler
 * still runs `safeParse` before any service call, returning 422 on failure
 * (CLAUDE.md §3.1). Types come from `z.infer` here, so a service takes its input type
 * from the schema rather than importing it back out of a controller.
 */
import { z } from "zod";

export const PROJECT_STAGES = [
  "market_research",
  "problem_validation",
  "team_building",
  "building_mvp",
  "raising_funding",
  "go_to_market",
] as const;

export const ROLE_COMMITMENTS = ["full_time", "part_time", "hobby"] as const;

export const PROJECT_STATUSES = ["draft", "active", "archived"] as const;

/** Basis points, 10000 = 100%. Integer only — no float ever touches equity (§4c). */
export const BasisPointsSchema = z.number().int().min(0).max(10_000);

export const ProjectFieldsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  tagline: z.string().trim().min(1).max(200),
  categoryId: z.string().trim().min(1),
  description: z.string().trim().max(20_000).optional(),
  problemStatement: z.string().trim().max(10_000).optional(),
  solutionSummary: z.string().trim().max(10_000).optional(),
  targetRegion: z.string().trim().max(200).optional(),
  demandEvidenceNotes: z.string().trim().max(10_000).optional(),
  seedRolesNeeded: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  offeredEquityBasisPointsMin: BasisPointsSchema.optional(),
  offeredEquityBasisPointsMax: BasisPointsSchema.optional(),
  expectedCommitment: z.enum(ROLE_COMMITMENTS).optional(),
});

/** Rejects an inverted band inside ONE payload; the service re-checks across PATCHes. */
export const equityBandIsOrdered = (value: {
  readonly offeredEquityBasisPointsMin?: number | undefined;
  readonly offeredEquityBasisPointsMax?: number | undefined;
}): boolean =>
  value.offeredEquityBasisPointsMin === undefined ||
  value.offeredEquityBasisPointsMax === undefined ||
  value.offeredEquityBasisPointsMin <= value.offeredEquityBasisPointsMax;

export const EQUITY_BAND_MESSAGE = {
  message: "The minimum offered equity cannot exceed the maximum.",
  path: ["offeredEquityBasisPointsMin"],
};

export const CreateProjectSchema = ProjectFieldsSchema.strict().refine(
  equityBandIsOrdered,
  EQUITY_BAND_MESSAGE,
);

export const UpdateProjectSchema = ProjectFieldsSchema.strict()
  .partial()
  .refine(equityBandIsOrdered, EQUITY_BAND_MESSAGE);

/** Stage has its OWN route because every change writes an append-only audit row. */
export const UpdateProjectStageSchema = z
  .object({
    stage: z.enum(PROJECT_STAGES),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();

/**
 * `founder` is absent from the enum entirely — it is written exactly once, by the
 * create transaction. `admin` is absent because its only purpose is co-signing escrow
 * releases (§7), and pre-seeding admins before that four-eyes flow exists is pure risk.
 */
export const UpdateMemberSchema = z
  .object({
    projectRole: z.enum(["maintainer", "contributor"]).optional(),
    roleTitle: z.string().trim().max(120).nullable().optional(),
  })
  .strict();

export const ListProjectsQuerySchema = z
  .object({
    category: z.string().trim().min(1).optional(),
    stage: z.enum(PROJECT_STAGES).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const ListMyProjectsQuerySchema = z
  .object({
    status: z.enum(PROJECT_STATUSES).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

/**
 * §11k.2. `insightId` is the ONLY key: `createdAt` and `linkedByUserId` are server-owned, and
 * the table carries no `source` column to assert (schema.ts records why it does not).
 *
 * `z.uuid()` matches how `market_insight.id` is actually minted (`randomUUID()`), so a
 * malformed id is a 422 here rather than a database round-trip ending in the same 404 every
 * other refusal on this route produces.
 */
export const LinkMarketInsightSchema = z.object({ insightId: z.uuid() }).strict();

export const InsightIdParamSchema = z.object({ insightId: z.uuid() }).strict();

export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>;
