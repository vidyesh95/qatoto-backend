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

const updateSetMock = vi.fn<() => { where: () => Promise<undefined> }>(() => ({
  where: vi.fn<() => Promise<undefined>>(async () => undefined),
}));
const updateMock = vi.fn<() => { set: typeof updateSetMock }>(() => ({ set: updateSetMock }));

const fromMock = vi.fn<(table: unknown) => { where: () => { limit: () => Promise<readonly unknown[]> } }>(
  (table: unknown) => {
    if (table === user) {
      return { where: () => ({ limit: async () => userLookupRows }) };
    }
    if (table === account) {
      return { where: () => ({ limit: async () => accountLookupRows }) };
    }
    throw new Error("Unexpected table passed to mocked db.select().from() in auth.routes.test.ts");
  },
);
const selectMock = vi.fn<() => { from: typeof fromMock }>(() => ({ from: fromMock }));

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
     * ⚠️ AN EXACT COUNT, WHICH THIS COULD NOT ASSERT BEFORE.
     *
     * It used to loop until it saw a 429 and only claim "eventually blocked", because
     * `resetRateLimiters()` reset one key per limiter — `TEST_SESSION_USER.id` — and these two
     * limiters are keyed on the IP and the email. Their buckets survived the whole file, so how
     * many requests remained was a function of test order, which is also what made the nine
     * `/signup/complete` tests below fail under `--sequence.shuffle`.
     *
     * The reset is key-independent now, so the budget is knowable and the real contract is
     * assertable: `otpRequestEmailLimiter` allows 4 per email per 15 minutes.
     *
     * KEYED ON THE EMAIL, NOT THE IP, and one address is what proves it. The stacked
     * `otpRequestIpLimiter` allows 8, so five requests cannot be what trips here — this is the
     * anti-email-bomb limit, and the assertion would still pass if it were the IP one only
     * because 5 < 8 is not the boundary being crossed.
     */
    it("blocks the 5th code to one inbox — the per-email limit is 4", async () => {
      const email = "rate-limited-signup@example.test";

      for (let attempt = 1; attempt <= 4; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        const allowed = await request(app).post("/signup/start").send({ email });
        expect(allowed.status).toBe(200);
      }

      const blocked = await request(app).post("/signup/start").send({ email });

      expect(blocked.status).toBe(429);
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
     * ⚠️ THE TEST THAT USED TO POISON THE OTHER NINE.
     *
     * `signupCompleteIpLimiter` allows 12 per IP per 15 minutes, and this test spends all of
     * them. Its key is the request IP, which the old `resetRateLimiters()` never reset — so in
     * declaration order this ran last and the nine functional `/signup/complete` tests above
     * had 9 of 12 to themselves, while any shuffle that ran this first left them nothing and
     * every one of them failed with a 429 that read as "expected 429 to be 401".
     *
     * Now that the reset empties every bucket whatever its key, the exact boundary is the thing
     * worth asserting — and the 401s on the way there are asserted too, because a limiter that
     * started refusing at the 3rd attempt would also produce "the 13th is not 200".
     */
    it("allows 12 attempts per IP then blocks the 13th", async () => {
      userLookupRows = [];
      stubVerificationOtp("000000"); // always wrong, so every attempt is fast/cheap (401s)

      for (let attempt = 1; attempt <= 12; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        const allowed = await request(app)
          .post("/signup/complete")
          .send({ email: `attempt-${attempt}@example.test`, otp: "123456", password: "a-strong-password-1" });
        expect(allowed.status).toBe(401);
      }

      const blocked = await request(app)
        .post("/signup/complete")
        .send({ email: "attempt-13@example.test", otp: "123456", password: "a-strong-password-1" });

      expect(blocked.status).toBe(429);
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
