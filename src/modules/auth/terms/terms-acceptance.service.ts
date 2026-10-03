import { and, desc, eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { user, userTermsAcceptance } from "#src/db/schema.js";
import { CURRENT_TERMS_VERSION } from "#src/lib/terms-version.js";
import type { Result } from "#src/types/index.js";

/**
 * Terms acceptance (todo §7): who accepted which version of the Terms, when, and on which surface.
 *
 * TWO RECORDS, ONE WRITE. `user_terms_acceptance` keeps every acceptance; `user.terms_version` and
 * `user.terms_accepted_at` hold the latest so the session can tell the client whether to ask
 * again. Both are written in one transaction here and nowhere else, so they cannot disagree.
 *
 * WHAT THIS DOES NOT DO: decide that anyone is bound by anything. It records that a surface which
 * showed the Terms beside an action was used, and which version it showed.
 */

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type TermsAcceptanceSurface = typeof userTermsAcceptance.$inferInsert.acceptanceSurface;

export type TermsAcceptanceError =
  /** The client acknowledged a version that is not the current one — reload, read, accept again. */
  { readonly type: "TERMS_VERSION_STALE"; readonly currentVersion: string };

export interface TermsAcceptanceProjection {
  readonly termsVersion: string;
  readonly termsAcceptedAt: Date;
}

export function isCurrentTermsVersion(acceptedTermsVersion: string): boolean {
  return acceptedTermsVersion === CURRENT_TERMS_VERSION;
}

/** Inserts the history row and moves the user's latest acceptance, inside the caller's transaction. */
export async function recordTermsAcceptance(
  transaction: DatabaseTransaction,
  userId: string,
  surface: TermsAcceptanceSurface,
): Promise<TermsAcceptanceProjection> {
  const acceptedAt = new Date();
  await transaction.insert(userTermsAcceptance).values({
    userId,
    termsVersion: CURRENT_TERMS_VERSION,
    acceptanceSurface: surface,
    acceptedAt,
  });
  await transaction
    .update(user)
    .set({ termsVersion: CURRENT_TERMS_VERSION, termsAcceptedAt: acceptedAt })
    .where(eq(user.id, userId));
  return { termsVersion: CURRENT_TERMS_VERSION, termsAcceptedAt: acceptedAt };
}

/**
 * The in-app banner's write. IDEMPOTENT PER VERSION: an account that already accepted the current
 * version gets its existing acceptance back and no second row — a double press, or two open tabs,
 * must not read as two separate agreements. A stale version is refused, never upgraded.
 */
export async function acceptCurrentTerms(
  userId: string,
  acceptedTermsVersion: string,
): Promise<Result<TermsAcceptanceProjection, TermsAcceptanceError>> {
  if (!isCurrentTermsVersion(acceptedTermsVersion)) {
    return {
      success: false,
      error: { type: "TERMS_VERSION_STALE", currentVersion: CURRENT_TERMS_VERSION },
    };
  }

  const acceptance = await db.transaction(async (transaction) => {
    const [existing] = await transaction
      .select({ acceptedAt: userTermsAcceptance.acceptedAt })
      .from(userTermsAcceptance)
      .where(
        and(
          eq(userTermsAcceptance.userId, userId),
          eq(userTermsAcceptance.termsVersion, CURRENT_TERMS_VERSION),
        ),
      )
      .orderBy(desc(userTermsAcceptance.acceptedAt))
      .limit(1);
    if (existing) {
      return { termsVersion: CURRENT_TERMS_VERSION, termsAcceptedAt: existing.acceptedAt };
    }
    return recordTermsAcceptance(transaction, userId, "in_app_banner");
  });

  return { success: true, value: acceptance };
}

/**
 * The email sign-up's write, AFTER the account exists. Looked up by the email the OTP proved, which
 * is unique — the sign-up paths hold an email, not an id, when they finish.
 */
export async function recordSignUpTermsAcceptance(email: string): Promise<void> {
  await db.transaction(async (transaction) => {
    const [signedUpUser] = await transaction
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email))
      .limit(1);
    if (!signedUpUser) return;
    await recordTermsAcceptance(transaction, signedUpUser.id, "email_sign_up");
  });
}

/**
 * A Google or GitHub FIRST sign-in — called from Better Auth's `user.create.after` hook, which knows
 * the user id but sits outside any transaction of ours. Every page that starts that flow carries the
 * Terms sentence beside the buttons; the version is the server's current one, kept in step with the
 * frontend's by the 409 on every other acceptance path.
 */
export async function recordOAuthSignUpTermsAcceptance(userId: string): Promise<void> {
  await db.transaction(async (transaction) => {
    await recordTermsAcceptance(transaction, userId, "oauth_sign_up");
  });
}
