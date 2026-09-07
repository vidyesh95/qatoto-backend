import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for staff role administration (R_AND_D_BACKEND_STRUCTURE.md §4a
 * Layer 3) — the two-person-control (four-eyes) mechanism that grants and revokes
 * `moderator`/`auditor`/`admin`. Previously untested at any tier above the service's own
 * `requirePlatformCapability` unit test — this is the single highest-priority RBAC gap
 * this pass closes: a wiring bug here is a path to a self-granted admin role.
 *
 * NO CAPABILITY MIDDLEWARE on any of these routes (by design — a middleware cannot
 * return a `Result` and so cannot join the exhaustive error switch). `manage_platform_roles`
 * is checked INSIDE the service, so every "403" case here is a mocked domain error, not a
 * different middleware chain.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const readOwnStaffContext = vi.fn<(...args: readonly unknown[]) => unknown>();
const findUserForRoleGrant = vi.fn<(...args: readonly unknown[]) => unknown>();
const listPendingPlatformRoleProposals = vi.fn<(...args: readonly unknown[]) => unknown>();
const proposePlatformRoleChange = vi.fn<(...args: readonly unknown[]) => unknown>();
const countersignPlatformRoleChange = vi.fn<(...args: readonly unknown[]) => unknown>();
const cancelPlatformRoleProposal = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/platform/roles/platform-roles-admin.service.js", () => ({
  readOwnStaffContext: (...args: readonly unknown[]) => readOwnStaffContext(...args),
  findUserForRoleGrant: (...args: readonly unknown[]) => findUserForRoleGrant(...args),
  listPendingPlatformRoleProposals: (...args: readonly unknown[]) => listPendingPlatformRoleProposals(...args),
  proposePlatformRoleChange: (...args: readonly unknown[]) => proposePlatformRoleChange(...args),
  countersignPlatformRoleChange: (...args: readonly unknown[]) => countersignPlatformRoleChange(...args),
  cancelPlatformRoleProposal: (...args: readonly unknown[]) => cancelPlatformRoleProposal(...args),
}));

const CAPABILITY_REQUIRED = { success: false, error: { type: "PLATFORM_CAPABILITY_REQUIRED" } } as const;

describe("platform roles routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe("authentication", () => {
    it.each([
      ["get", "/admin/whoami"] as const,
      ["get", "/admin/platform-roles/lookup?email=someone@example.test"] as const,
      ["get", "/admin/platform-roles/proposals"] as const,
    ])("answers 401 for a signed-out caller on %s %s", async (method, path) => {
      signOut();

      const response = await request(app)[method](path);

      expect(response.status).toBe(401);
      expect(readOwnStaffContext).not.toHaveBeenCalled();
      expect(findUserForRoleGrant).not.toHaveBeenCalled();
      expect(listPendingPlatformRoleProposals).not.toHaveBeenCalled();
    });

    it("answers 401 for a signed-out caller proposing a role change", async () => {
      signOut();

      const response = await request(app)
        .post("/admin/platform-roles/proposals")
        .send({ email: "someone@example.test", role: "moderator" });

      expect(response.status).toBe(401);
      expect(proposePlatformRoleChange).not.toHaveBeenCalled();
    });
  });

  describe("GET /admin/whoami", () => {
    it("reports the caller's own staff context", async () => {
      readOwnStaffContext.mockResolvedValue({ platformRole: "admin", capabilities: ["manage_platform_roles"] });

      const response = await request(app).get("/admin/whoami");

      expect(response.status).toBe(200);
      expect(readOwnStaffContext).toHaveBeenCalledWith("user_test_caller");
      expect(response.body.data).toEqual({ platformRole: "admin", capabilities: ["manage_platform_roles"] });
    });

    it("answers 401 for a live session with no user row", async () => {
      readOwnStaffContext.mockResolvedValue(null);

      const response = await request(app).get("/admin/whoami");

      expect(response.status).toBe(401);
    });
  });

  describe("GET /admin/platform-roles/lookup", () => {
    const path = "/admin/platform-roles/lookup?email=target@example.test";

    it("requires manage_platform_roles", async () => {
      findUserForRoleGrant.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app).get(path);

      expect(response.status).toBe(403);
    });

    it("looks up exactly one account by email", async () => {
      findUserForRoleGrant.mockResolvedValue({
        success: true,
        value: { id: "user_target", email: "target@example.test", platformRole: null },
      });

      const response = await request(app).get(path);

      expect(response.status).toBe(200);
      expect(findUserForRoleGrant).toHaveBeenCalledWith("user_test_caller", "target@example.test");
      expect(response.body.data).toEqual({ id: "user_target", email: "target@example.test", platformRole: null });
    });

    it("maps USER_NOT_FOUND to 404", async () => {
      findUserForRoleGrant.mockResolvedValue({ success: false, error: { type: "USER_NOT_FOUND" } });

      const response = await request(app).get(path);

      expect(response.status).toBe(404);
    });

    it("rejects a malformed email with 422 and never calls the service", async () => {
      const response = await request(app).get("/admin/platform-roles/lookup?email=not-an-email");

      expect(response.status).toBe(422);
      expect(findUserForRoleGrant).not.toHaveBeenCalled();
    });

    it("rejects an unknown query key with 422", async () => {
      const response = await request(app).get(`${path}&role=admin`);

      expect(response.status).toBe(422);
      expect(findUserForRoleGrant).not.toHaveBeenCalled();
    });
  });

  describe("GET /admin/platform-roles/proposals", () => {
    it("requires manage_platform_roles", async () => {
      listPendingPlatformRoleProposals.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app).get("/admin/platform-roles/proposals");

      expect(response.status).toBe(403);
    });

    it("lists proposals waiting for a countersignature", async () => {
      listPendingPlatformRoleProposals.mockResolvedValue({
        success: true,
        value: [{ id: "proposal_1", email: "target@example.test", proposedRole: "moderator" }],
      });

      const response = await request(app).get("/admin/platform-roles/proposals");

      expect(response.status).toBe(200);
      expect(listPendingPlatformRoleProposals).toHaveBeenCalledWith("user_test_caller");
      expect(response.body.data).toEqual([
        { id: "proposal_1", email: "target@example.test", proposedRole: "moderator" },
      ]);
    });
  });

  describe("POST /admin/platform-roles/proposals", () => {
    const path = "/admin/platform-roles/proposals";
    const validBody = { email: "target@example.test", role: "moderator" };

    it("requires manage_platform_roles", async () => {
      proposePlatformRoleChange.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(403);
    });

    it("proposes the change and answers 201 — a proposal, never a grant", async () => {
      proposePlatformRoleChange.mockResolvedValue({
        success: true,
        value: { id: "proposal_1", email: "target@example.test", proposedRole: "moderator", status: "pending" },
      });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(201);
      expect(proposePlatformRoleChange).toHaveBeenCalledWith("user_test_caller", {
        email: "target@example.test",
        nextPlatformRole: "moderator",
        note: "",
      });
    });

    it("accepts role: null as a revocation", async () => {
      proposePlatformRoleChange.mockResolvedValue({
        success: true,
        value: { id: "proposal_2", email: "target@example.test", proposedRole: null, status: "pending" },
      });

      const response = await request(app)
        .post(path)
        .send({ email: "target@example.test", role: null, note: "Stepping down." });

      expect(response.status).toBe(201);
      expect(proposePlatformRoleChange).toHaveBeenCalledWith("user_test_caller", {
        email: "target@example.test",
        nextPlatformRole: null,
        note: "Stepping down.",
      });
    });

    it("rejects a role outside the enum with 422", async () => {
      const response = await request(app).post(path).send({ email: "target@example.test", role: "superadmin" });

      expect(response.status).toBe(422);
      expect(proposePlatformRoleChange).not.toHaveBeenCalled();
    });

    /**
     * The self-dealing rule this whole subtree exists to prevent: an admin cannot propose
     * a change to their own role, closing the most direct path to a self-granted admin.
     */
    it("maps CANNOT_CHANGE_OWN_ROLE to 409", async () => {
      proposePlatformRoleChange.mockResolvedValue({
        success: false,
        error: { type: "CANNOT_CHANGE_OWN_ROLE" },
      });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(409);
    });

    it("maps ROLE_ALREADY_SET to 409", async () => {
      proposePlatformRoleChange.mockResolvedValue({
        success: false,
        error: { type: "ROLE_ALREADY_SET", platformRole: "moderator" },
      });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(409);
    });

    it("maps PROPOSAL_ALREADY_EXISTS to 409", async () => {
      proposePlatformRoleChange.mockResolvedValue({
        success: false,
        error: { type: "PROPOSAL_ALREADY_EXISTS" },
      });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(409);
    });

    it("maps USER_NOT_FOUND to 404", async () => {
      proposePlatformRoleChange.mockResolvedValue({ success: false, error: { type: "USER_NOT_FOUND" } });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(404);
    });
  });

  describe("POST /admin/platform-roles/proposals/:proposalId/countersign — four-eyes", () => {
    const path = "/admin/platform-roles/proposals/proposal_1/countersign";

    it("requires manage_platform_roles", async () => {
      countersignPlatformRoleChange.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app).post(path).send({});

      expect(response.status).toBe(403);
    });

    it("countersigns and applies the role", async () => {
      countersignPlatformRoleChange.mockResolvedValue({
        success: true,
        value: { id: "proposal_1", status: "applied" },
      });

      const response = await request(app).post(path).send({ note: "Confirmed with the team." });

      expect(response.status).toBe(200);
      expect(countersignPlatformRoleChange).toHaveBeenCalledWith("user_test_caller", "proposal_1", {
        note: "Confirmed with the team.",
      });
    });

    it("accepts a bodyless countersign", async () => {
      countersignPlatformRoleChange.mockResolvedValue({
        success: true,
        value: { id: "proposal_1", status: "applied" },
      });

      const response = await request(app).post(path);

      expect(response.status).toBe(200);
      expect(countersignPlatformRoleChange).toHaveBeenCalledWith("user_test_caller", "proposal_1", { note: "" });
    });

    /**
     * §7A.5's own rule, applied here to staff roles: the proposer cannot also be the
     * countersigner, EVEN FOR A FOUNDER-EQUIVALENT ADMIN. 422, not 403 — the caller IS
     * authorized; the request itself is the problem.
     */
    it("answers 422 SELF_COUNTERSIGN_FORBIDDEN when the proposer tries to countersign their own proposal", async () => {
      countersignPlatformRoleChange.mockResolvedValue({
        success: false,
        error: { type: "SELF_COUNTERSIGN_FORBIDDEN" },
      });

      const response = await request(app).post(path).send({});

      expect(response.status).toBe(422);
    });

    it("maps PROPOSAL_NOT_FOUND to 404", async () => {
      countersignPlatformRoleChange.mockResolvedValue({
        success: false,
        error: { type: "PROPOSAL_NOT_FOUND" },
      });

      const response = await request(app).post(path).send({});

      expect(response.status).toBe(404);
    });

    it("maps PROPOSAL_ALREADY_DECIDED to 409", async () => {
      countersignPlatformRoleChange.mockResolvedValue({
        success: false,
        error: { type: "PROPOSAL_ALREADY_DECIDED" },
      });

      const response = await request(app).post(path).send({});

      expect(response.status).toBe(409);
    });

    /**
     * The subject's role moved between propose and countersign — the transition being
     * ratified no longer exists. Refused rather than silently applied against stale state.
     */
    it("maps SUBJECT_ROLE_CHANGED to 409", async () => {
      countersignPlatformRoleChange.mockResolvedValue({
        success: false,
        error: { type: "SUBJECT_ROLE_CHANGED", platformRole: "auditor" },
      });

      const response = await request(app).post(path).send({});

      expect(response.status).toBe(409);
    });

    it("rejects an unknown body field with 422", async () => {
      const response = await request(app).post(path).send({ approve: true });

      expect(response.status).toBe(422);
      expect(countersignPlatformRoleChange).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /admin/platform-roles/proposals/:proposalId", () => {
    const path = "/admin/platform-roles/proposals/proposal_1";

    it("requires manage_platform_roles", async () => {
      cancelPlatformRoleProposal.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app).delete(path);

      expect(response.status).toBe(403);
    });

    it("withdraws a live proposal", async () => {
      cancelPlatformRoleProposal.mockResolvedValue({
        success: true,
        value: { id: "proposal_1", status: "withdrawn" },
      });

      const response = await request(app).delete(path);

      expect(response.status).toBe(200);
      expect(cancelPlatformRoleProposal).toHaveBeenCalledWith("user_test_caller", "proposal_1");
    });

    it("maps PROPOSAL_NOT_FOUND to 404", async () => {
      cancelPlatformRoleProposal.mockResolvedValue({
        success: false,
        error: { type: "PROPOSAL_NOT_FOUND" },
      });

      const response = await request(app).delete(path);

      expect(response.status).toBe(404);
    });

    it("maps PROPOSAL_ALREADY_DECIDED to 409", async () => {
      cancelPlatformRoleProposal.mockResolvedValue({
        success: false,
        error: { type: "PROPOSAL_ALREADY_DECIDED" },
      });

      const response = await request(app).delete(path);

      expect(response.status).toBe(409);
    });
  });
});
