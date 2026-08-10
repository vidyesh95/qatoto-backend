import { and, eq, exists, isNull, or, sql } from "drizzle-orm";
import type { Request, Response, NextFunction } from "express";

import { db } from "#src/db/index.js";
import { account, passkey, user } from "#src/db/schema.js";

/**
 * Proves the caller is a REAL, ACCOUNTABLE account — not merely that a session row
 * exists. Runs AFTER `requireAuth`, never instead of it.
 *
 * Why this exists (R_AND_D_BACKEND_STRUCTURE.md §4a): `src/lib/auth.ts` registers the
 * `anonymous()` plugin, so `POST /api/auth/sign-in/anonymous` creates a real `session`
 * row. `auth.api.getSession` resolves it, `requireAuth` attaches `req.user` and calls
 * `next()`. Every endpoint that moves money, mints equity, or contributes to a
 * distinct-count is therefore open to unlimited throwaway identities. Apply this guard
 * to every write that touches money, equity, effort, a distinct-count, or a uniqueness
 * quota.
 *
 * The predicate is an AND of two independent clauses, and BOTH are load-bearing:
 *
 *   1. NOT anonymous — `user.isAnonymous` is nullable, so NULL must read as "not
 *      anonymous" (the column postdates the earliest rows). Clause 2 alone would admit
 *      an anonymous user who registered a passkey, because the passkey plugin's
 *      `registration.requireSession: true` is satisfied by an ANONYMOUS session.
 *
 *   2. Has an `account` OR a `passkey` row — clause 1 alone would admit an "orphan":
 *      a verified-email user with no credential, which the pre-atomic OTP signup flow
 *      left behind and which can still sign in via `/sign-in/email-otp`. Run
 *      `pnpm db:cleanup-orphans` before deploying this.
 *
 * Note the spec's own wording ("at least one non-anonymous `account` row") is wrong on
 * two counts, both verified against the installed packages: `/sign-in/anonymous` never
 * calls `createAccount`, so there is no such thing as an anonymous account row to
 * exclude; and `@better-auth/passkey` never calls `createAccount` either, so a
 * passkey-only user has ZERO account rows and an account-only check would lock them
 * out of the entire domain.
 *
 * Fails with 403, NOT 401 — the caller HAS a session, it is just not enough.
 *
 * Deliberately NOT cached: a cache that is stale in the wrong direction reopens the
 * exact sybil hole this closes. Deliberately no try/catch: Express 5 forwards a
 * rejected middleware promise to `errorHandler`, which is the correct outcome for a
 * lost DB connection (CLAUDE.md §3.3 — throw only for the unrecoverable).
 */
/**
 * THE PREDICATE ITSELF, exported so a read can ask the same question this guard asks.
 *
 * §18.4 needs it: `community_cofounder_profile.identityState` is a badge that says "this
 * person is who they say they are", and there was a standing temptation to mint a second
 * notion of "identified" for that surface. Two definitions is how one of them silently
 * becomes the weaker, so the badge derives from THIS function and the guard keeps using it
 * too — they cannot drift because there is one predicate.
 *
 * Still not cached, for the reason above: stale in the wrong direction reopens the hole.
 */
export async function isIdentifiedUser(userId: string): Promise<boolean> {
  const identifiedRows = await db
    .select({ id: user.id })
    .from(user)
    .where(
      and(
        eq(user.id, userId),
        or(isNull(user.isAnonymous), eq(user.isAnonymous, false)),
        or(
          exists(
            db
              .select({ exists: sql`1` })
              .from(account)
              .where(eq(account.userId, user.id)),
          ),
          exists(
            db
              .select({ exists: sql`1` })
              .from(passkey)
              .where(eq(passkey.userId, user.id)),
          ),
        ),
      ),
    )
    .limit(1);
  return identifiedRows.length > 0;
}

export async function requireIdentifiedUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    });
    return;
  }

  if (!(await isIdentifiedUser(req.user.id))) {
    res.status(403).json({
      status: "error",
      statusCode: 403,
      message: "This action requires a full account. Please finish signing up.",
    });
    return;
  }

  next();
}
