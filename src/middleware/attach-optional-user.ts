import { fromNodeHeaders } from "better-auth/node";
import type { Request, Response, NextFunction } from "express";

import { auth } from "#src/lib/auth.js";

/**
 * Resolves a session IF one is present, and never 401s.
 *
 * The R&D read surface is genuinely public: §5 says active projects are "publicly
 * readable", and Next.js calls `GET /research-projects/slugs` at BUILD TIME from
 * `generateStaticParams`, with no cookie at all. So `requireAuth` cannot guard these
 * routes.
 *
 * But the response still depends on the viewer — `isWatchedByViewer` and
 * `viewerProjectRole` are properties of the CALLER, not of the row, and a draft project
 * must resolve for its members while 404ing for everyone else. That needs an OPTIONAL
 * identity: attach it when it exists, carry on when it does not.
 *
 * Identity is still server-derived (CLAUDE.md §1.1). This middleware only makes the
 * session optional, never client-assertable — there is no header or query parameter
 * that can name a user here.
 *
 * `req.authSession` is attached alongside `req.user`, exactly as `requireAuth` does.
 * The public store reads need `activeOrganizationId` to answer viewer-scoped questions
 * — "have I saved this product", "may I open a chat about it" — and the session object
 * was already being resolved here and thrown away. A read that silently answered `false`
 * because the field was unreachable would be worse than one that could not answer.
 */
export async function attachOptionalUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });

  if (session) {
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
  }

  next();
}
