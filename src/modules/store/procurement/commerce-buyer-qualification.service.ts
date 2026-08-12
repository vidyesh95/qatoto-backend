import { and, count, eq, lt, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceBusinessEmailDomain,
  commerceOrder,
  commerceOrganization,
  commerceOrganizationRankingExclusion,
  commerceOrganizationVerification,
  user,
  type commerceBuyerQualificationReasonEnum,
  type commerceBuyerQualificationStateEnum,
} from "#src/db/schema.js";

/**
 * The trusted-buyer filter (STORE Phase 13, refinement 2).
 *
 * WHAT THIS DECIDES. Whether one order may count toward a product's order velocity. It is
 * the single most important input to the ranking engine, because an order is the most
 * expensive signal to forge — but only if the account behind it is expensive to obtain.
 * Without this test, ranking rewards whoever can register accounts fastest.
 *
 * WHEN IT RUNS: EXACTLY ONCE, AT CONFIRM, AND NEVER AGAIN. The verdict is stamped onto
 * `commerce_order` and frozen. Evaluated at read time instead, a buyer that registers a
 * tax identifier today would retroactively qualify every order it has ever placed —
 * turning a fraud filter into a one-click amplifier for exactly the party it constrains.
 * That is also why this module returns a verdict rather than a predicate: nothing may ask
 * "is this buyer qualified" about a past order except by reading what was stamped.
 *
 * THE BAR: an age test AND at least one credential.
 *
 *   age        — the acting user's account is at least 7 days old
 *   credential — a prior order older than 7 days, OR a verified business email domain,
 *                OR an approved business-registration/tax-registration verification, OR a
 *                registration/tax identifier on file
 *
 * WHY BOTH HALVES. Age alone is trivially farmed by anyone patient. A credential alone is
 * trivially farmed by anyone who can put a string in a field. Together they cost either
 * time or a document review, which is the point.
 *
 * ## What this filter cannot do, and the honest shape of that
 *
 * The specification also asks to exclude internal, test, blocked and high-linkage orders.
 *
 *   - Internal/test/blocked: this database has no such flag on `user` or
 *     `commerce_organization`, and no operational process would keep one current. The
 *     mechanism that exists is `commerce_organization_ranking_exclusion`, which ships
 *     EMPTY apart from development seed organizations.
 *   - High-linkage: no table relates two accounts by any shared attribute. That is graph
 *     work and is not built.
 *
 * Both are checked here anyway, against the surfaces that DO exist, so that the day either
 * corpus is populated the filter starts using it without a code change. Until then they
 * are inert, and the rollout document says so rather than letting a reader infer coverage
 * from the presence of a check.
 *
 * ## The credential that can deny but almost never grant
 *
 * `verified_business_email_domain` reads `commerce_business_email_domain`, where ABSENCE
 * MEANS `unknown`, NEVER `verified_business`. A denylist of free-mail and disposable
 * providers is obtainable; an allowlist of every legitimate company domain is not. So in
 * practice this credential denies (a disposable domain fails the whole test outright) far
 * more often than it grants.
 */

type QualificationState = (typeof commerceBuyerQualificationStateEnum.enumValues)[number];
type QualificationReason = (typeof commerceBuyerQualificationReasonEnum.enumValues)[number];

export interface BuyerQualificationVerdict {
  /**
   * Never `unevaluated` from this function. That value exists only for rows written before
   * Phase 13 — a row that was never assessed, which is a different fact from failing.
   */
  readonly state: Exclude<QualificationState, "unevaluated">;
  readonly reasons: readonly QualificationReason[];
}

export interface EvaluateBuyerQualificationInput {
  readonly buyerOrganizationId: string;
  /** The member's user, i.e. who actually placed the order. */
  readonly actingUserId: string;
  readonly orderId: string;
  /** Every line on this order is a sample. Samples are excluded — see below. */
  readonly isSampleOnlyOrder: boolean;
  /** The confirm instant. Both age tests are relative to this, never to `now()`. */
  readonly occurredAt: Date;
}

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DatabaseExecutor = DatabaseTransaction | typeof db;

/** Both the account-age bar and the prior-order recency bar. */
const QUALIFYING_ACCOUNT_AGE_DAYS = 7;
const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * The credential half of the bar, as a discriminated set rather than a boolean, so the
 * stamped reasons say WHICH credential answered. A reviewer looking at a suppressed
 * product needs that; "qualified: true" is not reviewable.
 */
const CREDENTIAL_REASONS: readonly QualificationReason[] = [
  "prior_order_history",
  "verified_business_email_domain",
  "business_registration_on_file",
  "tax_identifier_on_file",
];

function isCredentialReason(reason: QualificationReason): boolean {
  return CREDENTIAL_REASONS.includes(reason);
}

/**
 * Evaluates the bar for one order.
 *
 * Takes an executor so it can run inside the confirm transaction — the verdict and the
 * state transition must commit together, or a crash between them leaves a confirmed order
 * with no stamp and no way to recover one honestly.
 */
export async function evaluateBuyerQualification(
  executor: DatabaseExecutor,
  input: EvaluateBuyerQualificationInput,
): Promise<BuyerQualificationVerdict> {
  const reasons: QualificationReason[] = [];

  /*
   * DISQUALIFIERS FIRST, and they short-circuit. A sample order is legitimate commerce and
   * is not fraud — it is simply not demand: A17 exists precisely because a sample bypasses
   * the tier ladder and the minimum order quantity, so counting one as a purchase would
   * let a seller rank on giveaways.
   */
  if (input.isSampleOnlyOrder) {
    return { state: "unqualified", reasons: ["sample_order"] };
  }

  const [organization] = await executor
    .select({
      tradeState: commerceOrganization.tradeState,
      registrationNumberEncrypted: commerceOrganization.registrationNumberEncrypted,
      taxIdentifierEncrypted: commerceOrganization.taxIdentifierEncrypted,
    })
    .from(commerceOrganization)
    .where(eq(commerceOrganization.id, input.buyerOrganizationId))
    .limit(1);

  if (!organization || organization.tradeState !== "active") {
    return { state: "unqualified", reasons: ["organization_not_active"] };
  }

  const [exclusion] = await executor
    .select({ organizationId: commerceOrganizationRankingExclusion.organizationId })
    .from(commerceOrganizationRankingExclusion)
    .where(eq(commerceOrganizationRankingExclusion.organizationId, input.buyerOrganizationId))
    .limit(1);

  if (exclusion) {
    return { state: "unqualified", reasons: ["organization_ranking_excluded"] };
  }

  const [actingUser] = await executor
    .select({
      createdAt: user.createdAt,
      email: user.email,
      isAnonymous: user.isAnonymous,
    })
    .from(user)
    .where(eq(user.id, input.actingUserId))
    .limit(1);

  if (!actingUser) {
    return { state: "unqualified", reasons: ["no_qualifying_credential"] };
  }

  // A better-auth anonymous session is not a buyer. It cannot hold a credential and its
  // age means nothing, so it fails before either half is considered.
  if (actingUser.isAnonymous === true) {
    return { state: "unqualified", reasons: ["anonymous_account"] };
  }

  // ---- half one: age -------------------------------------------------------
  const accountAgeMilliseconds = input.occurredAt.getTime() - actingUser.createdAt.getTime();
  const meetsAgeBar = accountAgeMilliseconds >= QUALIFYING_ACCOUNT_AGE_DAYS * MILLISECONDS_PER_DAY;
  reasons.push(meetsAgeBar ? "account_age_met" : "account_too_new");

  // ---- half two: at least one credential -----------------------------------
  const priorOrderCutoff = new Date(
    input.occurredAt.getTime() - QUALIFYING_ACCOUNT_AGE_DAYS * MILLISECONDS_PER_DAY,
  );

  /*
   * `createdAt` and NOT `confirmedAt` here, deliberately, and this is the one place the two
   * clocks legitimately differ. The velocity WINDOW must use `confirmedAt`, because that is
   * when demand happened. But "has this buyer transacted before" is a question about
   * history, and `confirmedAt` is null for every order placed before Phase 13 — so using it
   * would make every established buyer on the platform look brand new for the first two
   * weeks, and disqualify the exact population this test is meant to admit.
   */
  const [priorOrders] = await executor
    .select({ total: count() })
    .from(commerceOrder)
    .where(
      and(
        eq(commerceOrder.buyerOrganizationId, input.buyerOrganizationId),
        lt(commerceOrder.createdAt, priorOrderCutoff),
        sql`${commerceOrder.id} <> ${input.orderId}`,
      ),
    );

  if ((priorOrders?.total ?? 0) > 0) reasons.push("prior_order_history");

  const emailDomain = extractEmailDomain(actingUser.email);
  if (emailDomain !== null) {
    const [domainRow] = await executor
      .select({ classification: commerceBusinessEmailDomain.classification })
      .from(commerceBusinessEmailDomain)
      .where(eq(commerceBusinessEmailDomain.domain, emailDomain))
      .limit(1);

    /*
     * A disposable domain is a HARD FAIL, not merely an absent credential. Everything else
     * on this list is evidence a buyer is real; a throwaway address is evidence they
     * intend not to be reachable, and letting account age alone carry such an order would
     * make the seven-day wait the entire cost of the attack.
     */
    if (domainRow?.classification === "disposable") {
      return { state: "unqualified", reasons: ["no_qualifying_credential"] };
    }
    if (domainRow?.classification === "verified_business") {
      reasons.push("verified_business_email_domain");
    }
  }

  const [approvedVerification] = await executor
    .select({ verificationKind: commerceOrganizationVerification.verificationKind })
    .from(commerceOrganizationVerification)
    .where(
      and(
        eq(commerceOrganizationVerification.organizationId, input.buyerOrganizationId),
        eq(commerceOrganizationVerification.state, "approved"),
        sql`${commerceOrganizationVerification.verificationKind} IN ('business_registration', 'tax_registration')`,
      ),
    )
    .limit(1);

  if (approvedVerification) reasons.push("business_registration_on_file");

  // Presence only — the values are ciphertext and are never compared, decrypted or logged
  // here. That a buyer supplied one at all is the signal.
  if (organization.taxIdentifierEncrypted !== null) reasons.push("tax_identifier_on_file");
  else if (organization.registrationNumberEncrypted !== null) {
    reasons.push("business_registration_on_file");
  }

  const uniqueReasons = [...new Set(reasons)];
  const hasCredential = uniqueReasons.some(isCredentialReason);
  const qualifies = meetsAgeBar && hasCredential;

  if (!qualifies && !uniqueReasons.some((reason) => reason === "account_too_new")) {
    uniqueReasons.push("no_qualifying_credential");
  }

  return {
    state: qualifies ? "qualified" : "unqualified",
    // Never empty: `commerce_order_qualification_reasons_ck` refuses a verdict with no
    // reason, and an unreviewable verdict is exactly what that constraint exists to stop.
    reasons: uniqueReasons,
  };
}

/**
 * The domain part of an email, lowercased, or `null` if the address does not have exactly
 * one `@` with content on both sides.
 *
 * Exported for tests. Parsing rather than trusting: a malformed address must produce no
 * lookup at all, not a lookup for a garbage key that could be planted in the domain table.
 */
export function extractEmailDomain(email: string): string | null {
  const parts = email.trim().toLowerCase().split("@");
  if (parts.length !== 2) return null;

  const [localPart, domain] = parts;
  if (localPart === undefined || localPart === "") return null;
  if (domain === undefined || domain === "" || !domain.includes(".")) return null;

  return domain;
}
