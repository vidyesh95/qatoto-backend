import { APIError } from "better-auth/api";
import { vi } from "vitest";
import { z } from "zod";

/**
 * The signed-in caller a route-level test speaks as, or `null` for a signed-out one.
 *
 * WHY A MUTABLE MODULE-LEVEL VALUE. `vi.mock` factories are hoisted, so the auth stub cannot
 * close over a per-test variable; instead the factory reads this box at call time and each
 * test sets it. `signInAs`/`signOut` are the only writers.
 */
const StubbedSessionUserSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    emailVerified: z.boolean(),
    handle: z.string().nullable(),
  })
  .readonly();
export type StubbedSessionUser = z.infer<typeof StubbedSessionUserSchema>;

/** What the stamped header carries: a caller, or `null` for a signed-out one. */
const StampedSessionSchema = StubbedSessionUserSchema.nullable();

let currentSessionUser: StubbedSessionUser | null = null;

export const TEST_SESSION_USER: StubbedSessionUser = {
  id: "user_test_caller",
  email: "caller@example.test",
  name: "Test Caller",
  emailVerified: true,
  handle: "test-caller",
};

/** Every subsequent request in this test carries a session for `user`. */
export function signInAs(user: Partial<StubbedSessionUser> = {}): StubbedSessionUser {
  currentSessionUser = { ...TEST_SESSION_USER, ...user };
  return currentSessionUser;
}

/** Every subsequent request is anonymous — `requireAuth` answers 401. */
export function signOut(): void {
  currentSessionUser = null;
}

/**
 * The header the caller's identity rides in on, for the duration of one request.
 *
 * Chosen rather than a cookie because `requireAuth` hands `fromNodeHeaders(req.headers)` to
 * `getSession`, so a header is the only channel that reaches the mock at all.
 */
const TEST_SESSION_HEADER = "x-test-session";

/**
 * Snapshot the current caller onto the request, at the moment the request ARRIVES.
 *
 * THIS IS WHAT MAKES THE SESSION PER-REQUEST INSTEAD OF PER-MODULE, and it is the whole fix
 * for a flake that survived every other attempt.
 *
 * The box below is module-level because `vi.mock` factories are hoisted and cannot close
 * over a per-test value. That was fine until a request outlived the test that made it: the
 * request ARRIVES while its own test is running, but `getSession` resolves later, and by
 * then `beforeEach` has run `signInAs()` or the previous test has run `signOut()`. The mock
 * read the box at resolution time and answered with the WRONG test's identity — a 401 in a
 * signed-in test, or a 200 in a signed-out one, attributed to whichever test was unlucky.
 *
 * Stamping at arrival closes that gap. Arrival is synchronous and always inside the correct
 * test; resolution can be as late as it likes, because the answer already travelled with the
 * request. Draining the event loop between tests could only narrow this window — measured
 * over 25 runs, it did not narrow it enough to matter. Carrying the identity removes it.
 *
 * Mounted ahead of the real app by `buildTestApp`.
 */
export function stampTestSession(
  req: { headers: Record<string, string | string[] | undefined> },
  _res: unknown,
  next: () => void,
): void {
  req.headers[TEST_SESSION_HEADER] = JSON.stringify(currentSessionUser);
  next();
}

/**
 * ---- Signup OTP flow (`auth.controller.ts`'s `createNewUserAccount` / `linkPasswordOrReject`) ----
 *
 * Same mutable-box reasoning as `currentSessionUser` above: `vi.mock` factories are
 * hoisted, so these have to be read at call time rather than closed over per test.
 */

/**
 * What `auth.api.getVerificationOTP` answers with. `null` (the default) means "no code
 * was ever sent" — every `/signup/complete` attempt reports 401 until a test calls this
 * with the code it's about to submit.
 */
let stubbedVerificationOtp: string | null = null;

export function stubVerificationOtp(otp: string | null): void {
  stubbedVerificationOtp = otp;
}

type SignupPathOutcome = "success" | "throws";

/**
 * Forces `auth.api.signUpEmail` (brand-new-email path) to either resolve or throw the
 * same `APIError` Better Auth throws when the email was claimed between the lookup and
 * the call — `createNewUserAccount` maps that race to a 409.
 */
let stubbedSignUpEmailOutcome: SignupPathOutcome = "success";
export function stubSignUpEmailOutcome(outcome: SignupPathOutcome): void {
  stubbedSignUpEmailOutcome = outcome;
}

/**
 * Forces `auth.api.signInEmailOTP` (existing-OAuth-user attach-password path) to either
 * resolve or throw — `linkPasswordOrReject` maps a thrown `APIError` here to a 401
 * (wrong/expired OTP).
 */
let stubbedSignInEmailOtpOutcome: SignupPathOutcome = "success";
export function stubSignInEmailOtpOutcome(outcome: SignupPathOutcome): void {
  stubbedSignInEmailOtpOutcome = outcome;
}

/** Resets every signup stub to its default — call from `beforeEach` in signup tests. */
export function resetSignupStubs(): void {
  stubbedVerificationOtp = null;
  stubbedSignUpEmailOutcome = "success";
  stubbedSignInEmailOtpOutcome = "success";
}

function fakeAuthHeaders(setCookies: readonly string[] = ["better-auth.session=test; Path=/"]): {
  getSetCookie: () => string[];
} {
  return { getSetCookie: () => [...setCookies] };
}

/**
 * The `#src/lib/auth.js` surface the middleware and the signup controller touch.
 *
 * `requireAuth` calls `auth.api.getSession`; `attachOptionalUser` and
 * `requireIdentifiedUser` read the same session. Returning `null` is what a signed-out
 * caller looks like to all three, which is why `signOut()` is a first-class state rather
 * than "do not call signInAs" — the 401 path is the one a client has to render (§14).
 *
 * Reads the stamped header when there is one, and falls back to the box otherwise — a unit
 * test that calls `getSession` directly, with no request behind it, still works.
 *
 * The signup-flow methods (`getVerificationOTP`, `signUpEmail`, `signInEmailOTP`,
 * `setPassword`) and the sibling `sendSignupOtp` export are stubbed here too, driven by
 * the boxes above, so `auth.controller.ts`'s signup handlers can be exercised at the HTTP
 * layer without a real Better Auth instance or database.
 */
export function authModuleMock(): Record<string, unknown> {
  return {
    auth: {
      api: {
        getSession: vi.fn(
          async (options?: {
            readonly headers?: { readonly get?: (name: string) => string | null };
          }) => {
            const stamped = options?.headers?.get?.(TEST_SESSION_HEADER) ?? null;
            const parsedStampedSession =
              stamped === null ? null : StampedSessionSchema.safeParse(JSON.parse(stamped));

            const user =
              parsedStampedSession === null
                ? currentSessionUser
                : parsedStampedSession.success
                  ? parsedStampedSession.data
                  : null;

            return user === null ? null : { user, session: { id: "session_test" } };
          },
        ),
        getVerificationOTP: vi.fn(async () => ({ otp: stubbedVerificationOtp })),
        signUpEmail: vi.fn(async () => {
          if (stubbedSignUpEmailOutcome === "throws") {
            throw new APIError("CONFLICT", { message: "Email already claimed." });
          }
          return { headers: fakeAuthHeaders() };
        }),
        signInEmailOTP: vi.fn(async () => {
          if (stubbedSignInEmailOtpOutcome === "throws") {
            throw new APIError("UNAUTHORIZED", { message: "Invalid or expired code." });
          }
          return { headers: fakeAuthHeaders() };
        }),
        setPassword: vi.fn(async () => undefined),
      },
      handler: vi.fn(),
    },
    sendSignupOtp: vi.fn(async () => ({ success: true, value: undefined })),
  };
}
