import { beforeAll, describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

/**
 * The derived half of the OpenAPI document (§11l.2 item 8).
 *
 * WHAT THIS PINS. The spec used to describe 27 paths and none of the R&D surface, and
 * nothing noticed because nothing checked. The assertion that matters is COVERAGE: every
 * route the routers declare has an entry, and the count is derived on both sides rather
 * than written down — a test with a hardcoded 197 would be the same staleness one layer up.
 */

stubServerEnvironment();
vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());

describe("derived R&D OpenAPI paths", () => {
  let paths: Record<string, Record<string, unknown>>;
  let routeCount: number;

  beforeAll(async () => {
    const module = await import("#src/docs/openapi-rnd.js");
    paths = module.buildRndPathItems();
    routeCount = module.countRndRoutes();
  });

  it("emits one operation per declared route", () => {
    const operationCount = Object.values(paths).reduce((total, pathItem) => total + Object.keys(pathItem).length, 0);

    // Both sides are derived from the same routers, so this asserts the transform loses
    // nothing — not a number somebody remembered.
    expect(operationCount).toBe(routeCount);
    // A floor, so an accidental empty inventory cannot pass by matching zero to zero.
    expect(operationCount).toBeGreaterThan(180);
  });

  it("translates Express params into OpenAPI params", () => {
    expect(Object.keys(paths)).toContain("/research-projects/{projectSlug}/slice-ledger");
    expect(Object.keys(paths).some((path) => path.includes(":"))).toBe(false);
  });

  it("declares every path parameter it names", () => {
    for (const [path, pathItem] of Object.entries(paths)) {
      const expected = [...path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]);
      if (expected.length === 0) continue;

      for (const operation of Object.values(pathItem)) {
        // Read through a guard rather than an assertion: the spec is untyped by design —
        // it is JSON on the way out — so a claim about its shape here would be a claim,
        // and this test exists to check.
        const parameters =
          typeof operation === "object" && operation !== null && "parameters" in operation ? operation.parameters : [];
        const names = Array.isArray(parameters)
          ? parameters.map((parameter) =>
              typeof parameter === "object" && parameter !== null && "name" in parameter ? String(parameter.name) : "",
            )
          : [];
        expect(names).toEqual(expected);
      }
    }
  });

  it("covers the surfaces the hand-written spec never mentioned", () => {
    // One from each domain that was entirely absent before.
    expect(paths["/research-projects/{projectSlug}/compensation-periods/{periodId}/finalize"]).toBeDefined();
    expect(paths["/research-projects/{projectSlug}/effort-claims"]).toBeDefined();
    expect(paths["/funding-rounds/{roundId}/pledges"]).toBeDefined();
    expect(paths["/notifications"]).toBeDefined();
    expect(paths["/admin/audit-trail/verify"]).toBeDefined();
  });

  it("carries a request body where there is one, and none where there is not", () => {
    // The §11l.2 item 8 remainder. `openapi-rnd-bodies.test.ts` enforces the map's
    // completeness; these two are the spot check that the wiring reaches the document.
    const submitClaim = paths["/research-projects/{projectSlug}/effort-claims"]?.["post"];
    expect(typeof submitClaim === "object" && submitClaim !== null && "requestBody" in submitClaim).toBe(true);

    // `/accept` deliberately takes no body — compensation.routes.ts:96-98 records that as a
    // decision, so claiming one here would document a field the server ignores.
    const acceptAgreement =
      paths["/research-projects/{projectSlug}/compensation-agreements/{agreementId}/accept"]?.["post"];
    expect(acceptAgreement).toBeDefined();
    expect(typeof acceptAgreement === "object" && acceptAgreement !== null && "requestBody" in acceptAgreement).toBe(
      false,
    );
  });

  it("marks the OAuth callback as resolvable without a session", () => {
    const callback = paths["/integrations/{provider}/callback"]?.["get"];
    expect(callback).toBeDefined();
    // A provider's redirect arrives with no cookie; requiring one in the spec would tell a
    // client generator to attach credentials that cannot exist (§9.10).
    expect(typeof callback === "object" && callback !== null && "security" in callback).toBe(false);
  });
});
