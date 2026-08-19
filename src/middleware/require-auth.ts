import { fromNodeHeaders } from "better-auth/node";
import type { Request, Response, NextFunction } from "express";

import { auth } from "#src/lib/auth.js";

/**
 * Guard for routes you own. Asks Better Auth who the caller is from the session
 * cookie — never trusts a client-sent id — and attaches `req.user`, or 401s.
 *
 * Zero-trust (CLAUDE.md §1.1): the session is re-derived server-side on every
 * request; the frontend cannot assert identity.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });

  if (!session) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    });
    return;
  }

  /**
   * BELT TO THE SESSION HOOK'S BRACES, AND IT COSTS NO QUERY.
   *
   * `getSession` already returns every `additionalFields` member on `session.user` —
   * which is how the handle below is read — so `deactivatedAt` is a field we already have
   * rather than a lookup we have to make. That matters: this runs on every authenticated
   * request on the platform.
   *
   * IT SHOULD BE UNREACHABLE. `POST /users/me/deletion-request` deletes every session row
   * in the same transaction that stamps `deactivated_at`, so the deactivating tab's next
   * request is a 401, not this. And `databaseHooks.session.create.before` clears
   * `deactivated_at` before any new session exists, so a fresh sign-in never lands here
   * either.
   *
   * What it closes is the one gap between those two: a sign-in already in flight when the
   * deletion transaction runs, whose session row is inserted just after the DELETE swept.
   * Narrow, real, and cheaper to refuse than to reason about.
   *
   * 403 NOT 401: the caller HAS a valid session. Telling them to sign in would be advice
   * that cannot work — and signing in is exactly what would UNDO this state, so the wrong
   * status here is actively misleading.
   */
  if (session.user.deactivatedAt) {
    res.status(403).json({
      status: "error",
      statusCode: 403,
      message: "This account is deactivated. Sign in again to restore it.",
    });
    return;
  }

  req.user = {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    emailVerified: session.user.emailVerified,
    handle: session.user.handle ?? null,
  };
  req.authSession = {
    id: session.session.id,
    activeOrganizationId: session.session.activeOrganizationId ?? null,
  };
  next();
}
