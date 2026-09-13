import { describe, expect, it } from "vitest";

import {
  actionKindForVerb,
  auditLabelForVerb,
  CASE_STUDY_MODERATION_STATES,
  parseCaseStudyModerationState,
  parseShowcaseLaunchModerationState,
  parseTeardownModerationState,
  resolveBlueprintTransition,
  SHOWCASE_LAUNCH_MODERATION_STATES,
  TEARDOWN_MODERATION_STATES,
} from "#src/modules/home/blueprints/blueprint-moderation-transitions.js";
import type {
  BlueprintModerationArm,
  BlueprintModerationState,
  BlueprintModerationVerb,
} from "#src/modules/home/blueprints/blueprint-moderation-transitions.js";

/**
 * The matrix, walked cell by cell.
 *
 * ⚠️ THE STATE LISTS ARE ASSERTED AGAINST THE SCHEMA'S CHECKs, not just used. If somebody widens
 * `teardown_moderation_state_ck` or `case_study_moderation_state_ck` without adding a row here,
 * the first case fails — rather than the new state quietly having no verbs and every request
 * against it throwing at runtime.
 */

const VERBS: readonly BlueprintModerationVerb[] = ["flag", "quarantine", "restore"];

/** Exhaustive by `never`, so a fourth arm cannot be added without being given a state list here. */
function statesForArm(arm: BlueprintModerationArm): readonly BlueprintModerationState[] {
  switch (arm) {
    case "teardown":
      return TEARDOWN_MODERATION_STATES;
    case "case_study":
      return CASE_STUDY_MODERATION_STATES;
    case "showcase":
      return SHOWCASE_LAUNCH_MODERATION_STATES;
    default: {
      const exhaustiveCheck: never = arm;
      throw new Error(`Unhandled moderation arm: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

describe("the blueprint moderation matrix", () => {
  it("lists exactly the states each arm's CHECK admits", () => {
    // Mirrors `teardown_moderation_state_ck`.
    expect([...TEARDOWN_MODERATION_STATES].toSorted()).toEqual([
      "flagged",
      "pending_review",
      "published",
      "quarantined",
    ]);
    // Mirrors `case_study_moderation_state_ck`. ⚠️ NO `quarantined`: no files to withhold.
    expect([...CASE_STUDY_MODERATION_STATES].toSorted()).toEqual([
      "flagged",
      "pending_review",
      "published",
      "rejected",
    ]);
    /*
     * Mirrors `showcase_launch_moderation_state_ck`. ⚠️ NO `quarantined`, and for a DIFFERENT
     * reason from the case-study arm's: a showcase HAS files, but they are its own maker's by
     * attestation, so a third-party rights claim against one alleges the attestation was a lie.
     */
    expect([...SHOWCASE_LAUNCH_MODERATION_STATES].toSorted()).toEqual([
      "flagged",
      "pending_review",
      "published",
      "rejected",
    ]);
  });

  it("resolves every (arm x state x verb) cell without throwing", () => {
    /*
     * ⚠️ THE ARM LIST AND THE STATE LOOKUP ARE BOTH EXHAUSTIVE ON PURPOSE. A `switch` with a
     * `never` default means adding a fourth arm to `BlueprintModerationArm` fails to compile HERE
     * as well as in the service — which is the only reason this count can be trusted as coverage
     * rather than as a number somebody updated to make the suite green.
     */
    const arms: readonly BlueprintModerationArm[] = ["teardown", "case_study", "showcase"];
    let resolvedCellCount = 0;

    for (const arm of arms) {
      const states = statesForArm(arm);
      for (const state of states) {
        for (const verb of VERBS) {
          const outcome = resolveBlueprintTransition(arm, state, verb);
          expect(outcome.kind, `${arm}/${state}/${verb} must resolve`).toBeTruthy();
          resolvedCellCount += 1;
        }
      }
    }

    // 4 teardown + 4 case-study + 4 showcase states, three verbs each.
    expect(resolvedCellCount).toBe(36);
  });

  describe("the teardown arm", () => {
    it("moves published to flagged and to quarantined", () => {
      expect(resolveBlueprintTransition("teardown", "published", "flag")).toEqual({
        kind: "allowed",
        nextState: "flagged",
      });
      expect(resolveBlueprintTransition("teardown", "published", "quarantine")).toEqual({
        kind: "allowed",
        nextState: "quarantined",
      });
    });

    it("escalates a flag to a quarantine but refuses the downgrade", () => {
      expect(resolveBlueprintTransition("teardown", "flagged", "quarantine")).toEqual({
        kind: "allowed",
        nextState: "quarantined",
      });
      /*
       * ⚠️ THE REFUSAL THAT LOOKS LIKE IT COULD BE A PERMISSION. A quarantine withholds a
       * publisher's files under an unresolved rights claim; downgrading to a flag REPUBLISHES them.
       * That is a restore followed by a flag — two decisions, two audit entries, two reason notes,
       * because somebody has to own the republication.
       */
      expect(resolveBlueprintTransition("teardown", "quarantined", "flag")).toEqual({
        kind: "quarantine_outranks_flag",
      });
    });

    it("restores from either withheld state", () => {
      expect(resolveBlueprintTransition("teardown", "flagged", "restore")).toEqual({
        kind: "allowed",
        nextState: "published",
      });
      expect(resolveBlueprintTransition("teardown", "quarantined", "restore")).toEqual({
        kind: "allowed",
        nextState: "published",
      });
    });

    it("refuses every verb on a row that was never public", () => {
      for (const verb of VERBS) {
        expect(resolveBlueprintTransition("teardown", "pending_review", verb)).toEqual({
          kind: "not_public_yet",
        });
      }
    });

    it("refuses a repeat of the state the row already holds", () => {
      expect(resolveBlueprintTransition("teardown", "flagged", "flag")).toEqual({
        kind: "already_in_state",
      });
      expect(resolveBlueprintTransition("teardown", "quarantined", "quarantine")).toEqual({
        kind: "already_in_state",
      });
      expect(resolveBlueprintTransition("teardown", "published", "restore")).toEqual({
        kind: "already_published",
      });
    });
  });

  describe("the case-study arm", () => {
    it("refuses quarantine in EVERY state — the arm has no such label", () => {
      for (const state of CASE_STUDY_MODERATION_STATES) {
        expect(
          resolveBlueprintTransition("case_study", state, "quarantine"),
          `quarantine must be refused on a ${state} case study`,
        ).toEqual({ kind: "not_available_on_arm" });
      }
    });

    it("flags and restores like the teardown arm", () => {
      expect(resolveBlueprintTransition("case_study", "published", "flag")).toEqual({
        kind: "allowed",
        nextState: "flagged",
      });
      expect(resolveBlueprintTransition("case_study", "flagged", "restore")).toEqual({
        kind: "allowed",
        nextState: "published",
      });
    });

    it("never treats rejected as a source — a rejection is terminal", () => {
      for (const verb of VERBS) {
        const outcome = resolveBlueprintTransition("case_study", "rejected", verb);
        expect(outcome.kind, `${verb} on a rejected case study`).not.toBe("allowed");
      }
    });
  });

  describe("the showcase arm", () => {
    it("refuses quarantine in EVERY state — the arm has no such label", () => {
      for (const state of SHOWCASE_LAUNCH_MODERATION_STATES) {
        expect(
          resolveBlueprintTransition("showcase", state, "quarantine"),
          `quarantine must be refused on a ${state} showcase launch`,
        ).toEqual({ kind: "not_available_on_arm" });
      }
    });

    it("flags and restores like the case-study arm", () => {
      expect(resolveBlueprintTransition("showcase", "published", "flag")).toEqual({
        kind: "allowed",
        nextState: "flagged",
      });
      expect(resolveBlueprintTransition("showcase", "flagged", "restore")).toEqual({
        kind: "allowed",
        nextState: "published",
      });
    });

    it("never treats rejected as a source — a rejection is terminal", () => {
      for (const verb of VERBS) {
        const outcome = resolveBlueprintTransition("showcase", "rejected", verb);
        expect(outcome.kind, `${verb} on a rejected launch`).not.toBe("allowed");
      }
    });

    it("refuses every verb on a launch that was never public", () => {
      for (const verb of VERBS) {
        const outcome = resolveBlueprintTransition("showcase", "pending_review", verb);
        expect(outcome.kind, `${verb} on a pending launch`).not.toBe("allowed");
      }
    });
  });

  describe("state narrowing", () => {
    it("accepts the states its arm admits and refuses the rest", () => {
      expect(parseTeardownModerationState("quarantined")).toBe("quarantined");
      // ⚠️ `quarantined` is a real label on the shared enum and NOT reachable on this arm.
      expect(parseCaseStudyModerationState("quarantined")).toBeNull();
      expect(parseShowcaseLaunchModerationState("quarantined")).toBeNull();
      expect(parseTeardownModerationState("rejected")).toBeNull();
      expect(parseTeardownModerationState("draft")).toBeNull();
      /*
       * ⚠️ THE SHOWCASE ARM ADMITS `rejected` WHERE THE TEARDOWN ARM DOES NOT. A rejected launch is
       * the same row it always was, sitting in `showcase_launch` with a moderator note; a rejected
       * teardown submission never became a `teardown` at all, so the published table has no such
       * state to narrow to.
       */
      expect(parseShowcaseLaunchModerationState("rejected")).toBe("rejected");
    });
  });

  describe("the labels each verb writes", () => {
    it("is verb-scoped, which is what makes the audit count three rather than five", () => {
      expect(VERBS.map(auditLabelForVerb)).toEqual([
        "blueprint_content_flagged",
        "blueprint_content_quarantined",
        "blueprint_content_restored",
      ]);
      expect(VERBS.map(actionKindForVerb)).toEqual(["content_flagged", "content_quarantined", "content_restored"]);
    });
  });
});
