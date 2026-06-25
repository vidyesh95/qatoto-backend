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

  req.user = {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    emailVerified: session.user.emailVerified,
    handle: session.user.handle ?? null,
  };
  next();
}
