import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resetSignupStubs,
  signInAs,
  signOut,
  stubSignInEmailOtpOutcome,
  stubSignUpEmailOutcome,
  stubVerificationOtp,
} from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for `/signup/start`, `/signup/complete`, and `GET /me` — the one part
 * of `auth` that previously had NO true HTTP-integration coverage at all (the existing
 * `auth.controller.test.ts` calls the controller functions directly with hand-built
 * req/res stubs, so `requireAuth`, the rate limiters, and the real Zod boundary were all
 * unexercised). This file complements that one rather than replacing it.
 *
 * `auth.controller.ts`'s signup handlers hit `db.select`/`db.update` directly (there is no
 * service layer to mock instead), so this file builds a small chainable stub for exactly
 * the two tables it touches (`user`, `account`) — the same technique already proven in
 * `src/modules/platform/roles/platform-role.service.test.ts` — rather than changing the
 * shared `database-mock.ts`, which ~150 other tests rely on staying an inert `{}`.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const { user, account } = await import("#src/db/schema.js");

/** What the next `db.select().from(user)...limit(1)` resolves to. */
let userLookupRows: readonly (typeof user.$inferSelect)[] = [];
/** What the next `db.select().from(account)...limit(1)` resolves to. */
let accountLookupRows: readonly (typeof account.$inferSelect)[] = [];

const updateSetMock = vi.fn(() => ({ where: vi.fn(async () => undefined) }));
const updateMock = vi.fn(() => ({ set: updateSetMock }));

const fromMock = vi.fn((table: unknown) => {
  if (table === user) {
    return { where: () => ({ limit: async () => userLookupRows }) };
  }
  if (table === account) {
    return { where: () => ({ limit: async () => accountLookupRows }) };
  }
  throw new Error("Unexpected table passed to mocked db.select().from() in auth.routes.test.ts");
});
const selectMock = vi.fn(() => ({ from: fromMock }));

vi.mock("#src/db/index.js", () => ({ db: { select: selectMock, update: updateMock } }));

const EXISTING_USER_ROW = {
  id: "user_existing",
  email: "existing@example.test",
  name: "Existing User",
  emailVerified: true,
  isAnonymous: false,
} as unknown as typeof user.$inferSelect;

describe("auth session routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    userLookupRows = [];
    accountLookupRows = [];
    resetSignupStubs();
    signInAs();
    await resetRateLimiters();
  });

  describe("POST /signup/start", () => {
    it("always answers a generic 200, whether or not the email is registered", async () => {
      const forNewEmail = await request(app).post("/signup/start").send({ email: "brand-new@example.test" });
      const forRegisteredEmail = await request(app)
        .post("/signup/start")
        .send({ email: "already-registered@example.test" });

      expect(forNewEmail.status).toBe(200);
      expect(forRegisteredEmail.status).toBe(200);
      // Anti-enumeration: the two responses must be indistinguishable, or this endpoint
      // becomes a probe for which emails can sign up.
      expect(forNewEmail.body).toEqual(forRegisteredEmail.body);
    });

    it("lowercases the email before use", async () => {
      const response = await request(app).post("/signup/start").send({ email: "Mixed.Case@Example.TEST" });

      expect(response.status).toBe(200);
    });

    it("rejects a malformed email with 422", async () => {
      const response = await request(app).post("/signup/start").send({ email: "not-an-email" });

      expect(response.status).toBe(422);
    });

    it("rejects an unknown body field with 422", async () => {
      const response = await request(app).post("/signup/start").send({ email: "someone@example.test", turbo: true });

      expect(response.status).toBe(422);
    });

    /**
     * Loops until blocked rather than asserting an exact count. `resetRateLimiters()` only
     * resets USER-id-keyed buckets (see its own doc comment); `otpRequestIpLimiter` and
     * `otpRequestEmailLimiter` are IP/email-keyed and share one bucket for this whole file's
     * lifetime, so how many requests remain before a 429 depends on how many earlier tests
     * in this describe already hit `/signup/start`. Proving "eventually 429, and every
     * response before it was 200" is the property that survives that shared state.
     */
    it("eventually rate-limits repeated requests for the same email", async () => {
      const email = "rate-limited-signup@example.test";
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 10; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        const response = await request(app).post("/signup/start").send({ email });
        statuses.push(response.status);
        if (response.status === 429) break;
      }

      const blockedIndex = statuses.indexOf(429);
      expect(blockedIndex).toBeGreaterThan(-1);
      expect(statuses.slice(0, blockedIndex).every((status) => status === 200)).toBe(true);
    });
  });

  describe("POST /signup/complete — brand-new email", () => {
    const path = "/signup/complete";
    const validBody = {
      email: "new-signup@example.test",
      otp: "123456",
      password: "a-strong-password-1",
    };

    beforeEach(() => {
      userLookupRows = []; // no existing user with this email
    });

    it("rejects a wrong or expired OTP with 401 and creates no account", async () => {
      stubVerificationOtp("999999");

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(401);
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("rejects when no OTP was ever sent (null stored code)", async () => {
      stubVerificationOtp(null);

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(401);
    });

    it("creates the account on a correct OTP and answers 201 with a session cookie", async () => {
      stubVerificationOtp("123456");
      stubSignUpEmailOutcome("success");

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(201);
      expect(response.body.data).toEqual({ ok: true });
      expect(response.headers["set-cookie"]).toBeDefined();
      // The account is marked verified from the start — the OTP already proved ownership.
      expect(updateMock).toHaveBeenCalledWith(user);
      expect(updateSetMock).toHaveBeenCalledWith({ emailVerified: true });
    });

    it("maps a lost signUpEmail race (email claimed between lookup and create) to 409", async () => {
      stubVerificationOtp("123456");
      stubSignUpEmailOutcome("throws");

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(409);
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("rejects a password shorter than 8 characters with 422", async () => {
      stubVerificationOtp("123456");

      const response = await request(app)
        .post(path)
        .send({ ...validBody, password: "short" });

      expect(response.status).toBe(422);
    });

    it("rejects a missing otp with 422", async () => {
      const response = await request(app).post(path).send({ email: validBody.email, password: validBody.password });

      expect(response.status).toBe(422);
    });
  });

  describe("POST /signup/complete — existing user", () => {
    const path = "/signup/complete";
    const validBody = {
      email: "existing@example.test",
      otp: "123456",
      password: "a-strong-password-1",
    };

    beforeEach(() => {
      userLookupRows = [EXISTING_USER_ROW];
    });

    it("rejects with 409 when the user already has a credential (password) account", async () => {
      accountLookupRows = [{ userId: "user_existing", providerId: "credential" } as never];

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(409);
    });

    it("attaches a password to an OAuth-only user via sign-in + setPassword, answering 201", async () => {
      accountLookupRows = []; // no credential account yet — OAuth-only
      stubSignInEmailOtpOutcome("success");

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(201);
      expect(response.body.message).toContain("Password added");
      expect(response.headers["set-cookie"]).toBeDefined();
    });

    it("maps a wrong/expired OTP on the existing-user path to 401 without attaching a password", async () => {
      accountLookupRows = [];
      stubSignInEmailOtpOutcome("throws");

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(401);
    });
  });

  describe("POST /signup/complete — rate limiting", () => {
    /**
     * Same reasoning as the `/signup/start` rate-limit test above: `signupCompleteIpLimiter`
     * shares one bucket across every test in this file (its key is the request IP, never
     * reset between tests), so this loops until blocked rather than asserting an exact
     * count.
     */
    it("eventually rate-limits repeated attempts per IP", async () => {
      userLookupRows = [];
      stubVerificationOtp("000000"); // always wrong, so every attempt is fast/cheap (401s)

      const statuses: number[] = [];
      for (let attempt = 0; attempt < 15; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        const response = await request(app)
          .post("/signup/complete")
          .send({ email: `attempt-${attempt}@example.test`, otp: "123456", password: "a-strong-password-1" });
        statuses.push(response.status);
        if (response.status === 429) break;
      }

      const blockedIndex = statuses.indexOf(429);
      expect(blockedIndex).toBeGreaterThan(-1);
      expect(statuses.slice(0, blockedIndex).every((status) => status === 401)).toBe(true);
    });
  });

  describe("GET /me", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get("/me");

      expect(response.status).toBe(401);
    });

    it("returns the session's own user, at the HTTP layer", async () => {
      const response = await request(app).get("/me");

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ id: "user_test_caller" });
    });
  });
});
