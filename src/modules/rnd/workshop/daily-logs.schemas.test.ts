import { describe, expect, it, vi } from "vitest";

// The controller imports its services, which pull in the db pool at module scope. Stub the
// modules so the schemas can be parsed without a configured environment — nothing here
// calls a handler.
vi.mock("#src/modules/rnd/workshop/daily-logs.service.js", () => ({}));
vi.mock("#src/modules/rnd/projects/project-membership.service.js", () => ({}));

const { ListDailyLogFeedQuerySchema } = await import("#src/modules/rnd/workshop/daily-logs.schemas.js");

/**
 * The cross-project feed's query (§11h, Appendix B2), asserted against §0 and §13.
 *
 * THE KEYS THAT ARE ABSENT ARE THE POINT. `GET /daily-logs` returns logs that are private
 * to their project's members, and the membership set is derived from `project_member`
 * server-side. Every key below is one an attacker would try in order to make that set
 * larger, and every one must be a 422 rather than a silently ignored parameter.
 */
describe("ListDailyLogFeedQuerySchema", () => {
  it("accepts an empty query — the feed defaults to every project the caller is in", () => {
    expect(ListDailyLogFeedQuerySchema.safeParse({}).success).toBe(true);
  });

  it.each([
    ["projectIds", { projectIds: ["prj-1", "prj-2"] }],
    ["projectId", { projectId: "prj-1" }],
    ["userId", { userId: "usr-1" }],
    ["memberId", { memberId: "mem-1" }],
    ["authorMemberId", { authorMemberId: "mem-1" }],
    ["includeAllProjects", { includeAllProjects: "true" }],
    ["visibility", { visibility: "public" }],
    ["status", { status: "draft" }],
  ])("rejects %s — it would be a client-supplied authorization input", (_label, query) => {
    expect(ListDailyLogFeedQuerySchema.safeParse(query).success).toBe(false);
  });

  it("accepts a single projectSlug, which can only NARROW the caller's own set", () => {
    const parsed = ListDailyLogFeedQuerySchema.safeParse({ projectSlug: "solar-kiln" });

    expect(parsed.success && parsed.data.projectSlug).toBe("solar-kiln");
  });

  it("rejects a repeated projectSlug — narrowing is one project, not a list", () => {
    const parsed = ListDailyLogFeedQuerySchema.safeParse({ projectSlug: ["a", "b"] });

    expect(parsed.success).toBe(false);
  });

  it.each(["blocker", "progress", "velocity", "suggestion"])("accepts the %s chip kind", (chipKind) => {
    expect(ListDailyLogFeedQuerySchema.safeParse({ chipKind }).success).toBe(true);
  });

  it("rejects an unknown chipKind rather than returning an empty page", () => {
    // An empty page would read as "no blockers this week", which is a claim about the
    // team rather than about the request.
    expect(ListDailyLogFeedQuerySchema.safeParse({ chipKind: "risk" }).success).toBe(false);
  });

  it("caps limit so one request cannot pull an unbounded feed", () => {
    expect(ListDailyLogFeedQuerySchema.safeParse({ limit: 50 }).success).toBe(true);
    expect(ListDailyLogFeedQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(ListDailyLogFeedQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it("coerces limit from its string query form", () => {
    const parsed = ListDailyLogFeedQuerySchema.safeParse({ limit: "10" });

    expect(parsed.success && parsed.data.limit).toBe(10);
  });

  it("rejects an empty cursor rather than treating it as absent", () => {
    // An empty string that silently meant "first page" would make a client's paging bug
    // look like a server that repeats the first page forever.
    expect(ListDailyLogFeedQuerySchema.safeParse({ cursor: "" }).success).toBe(false);
  });

  it("rejects offset paging — this feed is keyset only", () => {
    expect(ListDailyLogFeedQuerySchema.safeParse({ page: 2 }).success).toBe(false);
    expect(ListDailyLogFeedQuerySchema.safeParse({ offset: 20 }).success).toBe(false);
  });
});
