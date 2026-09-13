/**
 * The state-transition matrix for the three moderation verbs, in ONE place.
 *
 * The service reads this and never re-states a pair. A matrix spread across a service's `if`s is
 * one somebody edits on one arm and forgets on the other — and the two arms here genuinely differ,
 * which is exactly the condition that makes a scattered version drift.
 *
 * ⚠️ THE SOURCE-STATE LISTS ARE ASSERTED AGAINST THE DATABASE'S OWN CHECKs by
 * `blueprint-moderation-transitions.test.ts`. If somebody widens
 * `teardown_moderation_state_ck` without adding a row here, that test fails rather than the new
 * state quietly having no verbs.
 */

export type BlueprintModerationArm = "teardown" | "case_study";
export type BlueprintModerationVerb = "flag" | "quarantine" | "restore";

/** The four states a teardown may hold — `teardown_moderation_state_ck`. */
export const TEARDOWN_MODERATION_STATES = [
  "pending_review",
  "published",
  "flagged",
  "quarantined",
] as const;

/** The four a case study may hold — `case_study_moderation_state_ck`. Note: no `quarantined`. */
export const CASE_STUDY_MODERATION_STATES = [
  "pending_review",
  "published",
  "rejected",
  "flagged",
] as const;

export type TeardownModerationState = (typeof TEARDOWN_MODERATION_STATES)[number];
export type CaseStudyModerationState = (typeof CASE_STUDY_MODERATION_STATES)[number];
export type BlueprintModerationState = TeardownModerationState | CaseStudyModerationState;

/**
 * Narrows the column's type to the states the arm's CHECK actually admits.
 *
 * ⚠️ THE COLUMN IS TYPED AS THE WHOLE SEVEN-LABEL `blueprint_moderation_state` ENUM, and only a
 * CHECK narrows it — which TypeScript cannot see. A cast would be the short way and is banned for
 * exactly this reason: it would assert a fact about the database that only the database holds.
 *
 * Returning `null` for an unlisted label is not defensive padding. It is the signal that somebody
 * widened `teardown_moderation_state_ck` or `case_study_moderation_state_ck` without adding a row
 * to the matrix below — and the caller turns it into a loud refusal rather than a silent
 * mis-transition.
 */
export function parseTeardownModerationState(candidate: string): TeardownModerationState | null {
  return TEARDOWN_MODERATION_STATES.find((state) => state === candidate) ?? null;
}

export function parseCaseStudyModerationState(candidate: string): CaseStudyModerationState | null {
  return CASE_STUDY_MODERATION_STATES.find((state) => state === candidate) ?? null;
}

export type BlueprintTransitionOutcome =
  | { readonly kind: "allowed"; readonly nextState: BlueprintModerationState }
  | { readonly kind: "already_in_state" }
  | { readonly kind: "not_public_yet" }
  | { readonly kind: "already_published" }
  | { readonly kind: "quarantine_outranks_flag" }
  | { readonly kind: "not_available_on_arm" };

/**
 * Resolves one `(arm, currentState, verb)` triple.
 *
 * Two refusals are worth defending, because both look like they could be permissions:
 *
 * ⚠️ `quarantined → flagged` IS REFUSED, NOT QUIETLY ALLOWED. A quarantine withholds a
 * publisher's files under an unresolved rights claim; downgrading it to a flag REPUBLISHES those
 * files. That is a `restore` followed by a `flag` — two decisions, and it must cost two audit
 * entries and two reason notes, because somebody has to own the republication.
 *
 * ⚠️ `rejected` IS NEVER A SOURCE. A rejection is terminal (blueprints doc §3.7) and a rejected
 * case study was never public, so there is nothing for any of these three verbs to act on.
 */
export function resolveBlueprintTransition(
  arm: BlueprintModerationArm,
  currentState: BlueprintModerationState,
  verb: BlueprintModerationVerb,
): BlueprintTransitionOutcome {
  // Quarantine exists on one arm only, and the refusal is arm-shaped rather than state-shaped.
  if (verb === "quarantine" && arm === "case_study") {
    return { kind: "not_available_on_arm" };
  }

  switch (currentState) {
    case "published":
      if (verb === "flag") return { kind: "allowed", nextState: "flagged" };
      if (verb === "quarantine") return { kind: "allowed", nextState: "quarantined" };
      return { kind: "already_published" };

    case "flagged":
      if (verb === "flag") return { kind: "already_in_state" };
      if (verb === "quarantine") return { kind: "allowed", nextState: "quarantined" };
      return { kind: "allowed", nextState: "published" };

    case "quarantined":
      if (verb === "flag") return { kind: "quarantine_outranks_flag" };
      if (verb === "quarantine") return { kind: "already_in_state" };
      return { kind: "allowed", nextState: "published" };

    case "pending_review":
    case "rejected":
      return { kind: "not_public_yet" };

    default: {
      const exhaustiveCheck: never = currentState;
      throw new Error(`Unhandled blueprint moderation state: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/** The audit label each verb writes. Verb-scoped, which is what makes the count three. */
export function auditLabelForVerb(
  verb: BlueprintModerationVerb,
): "blueprint_content_flagged" | "blueprint_content_quarantined" | "blueprint_content_restored" {
  switch (verb) {
    case "flag":
      return "blueprint_content_flagged";
    case "quarantine":
      return "blueprint_content_quarantined";
    case "restore":
      return "blueprint_content_restored";
    default: {
      const exhaustiveCheck: never = verb;
      throw new Error(`Unhandled blueprint moderation verb: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/** The `blueprint_moderation_action_kind` each verb records. */
export function actionKindForVerb(
  verb: BlueprintModerationVerb,
): "content_flagged" | "content_quarantined" | "content_restored" {
  switch (verb) {
    case "flag":
      return "content_flagged";
    case "quarantine":
      return "content_quarantined";
    case "restore":
      return "content_restored";
    default: {
      const exhaustiveCheck: never = verb;
      throw new Error(`Unhandled blueprint moderation verb: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
