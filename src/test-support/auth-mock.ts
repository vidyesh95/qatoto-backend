import { vi } from "vitest";

/**
 * The signed-in caller a route-level test speaks as, or `null` for a signed-out one.
 *
 * WHY A MUTABLE MODULE-LEVEL VALUE. `vi.mock` factories are hoisted, so the auth stub cannot
 * close over a per-test variable; instead the factory reads this box at call time and each
 * test sets it. `signInAs`/`signOut` are the only writers.
 */
interface StubbedSessionUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly emailVerified: boolean;
  readonly handle: string | null;
}

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
 * The `#src/lib/auth.js` surface the middleware touches.
 *
 * `requireAuth` calls `auth.api.getSession`; `attachOptionalUser` and
 * `requireIdentifiedUser` read the same session. Returning `null` is what a signed-out
 * caller looks like to all three, which is why `signOut()` is a first-class state rather
 * than "do not call signInAs" — the 401 path is the one a client has to render (§14).
 */
export function authModuleMock(): Record<string, unknown> {
  return {
    auth: {
      api: {
        getSession: vi.fn(async () => {
          const user = currentSessionUser;
          return user === null ? null : { user, session: { id: "session_test" } };
        }),
      },
      handler: vi.fn(),
    },
  };
}
