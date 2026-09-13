import { describe, expect, it } from "vitest";

import {
  actionKindForVerb,
  auditLabelForVerb,
  CASE_STUDY_MODERATION_STATES,
  parseCaseStudyModerationState,
  parseTeardownModerationState,
  resolveBlueprintTransition,
  TEARDOWN_MODERATION_STATES,
} from "#src/modules/home/blueprints/blueprint-moderation-transitions.js";
import type {
  BlueprintModerationArm,
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
  });

  it("resolves every (arm x state x verb) cell without throwing", () => {
    const arms: readonly BlueprintModerationArm[] = ["teardown", "case_study"];
    let resolvedCellCount = 0;

    for (const arm of arms) {
      const states = arm === "teardown" ? TEARDOWN_MODERATION_STATES : CASE_STUDY_MODERATION_STATES;
      for (const state of states) {
        for (const verb of VERBS) {
          const outcome = resolveBlueprintTransition(arm, state, verb);
          expect(outcome.kind, `${arm}/${state}/${verb} must resolve`).toBeTruthy();
          resolvedCellCount += 1;
        }
      }
    }

    // 4 teardown states + 4 case-study states, three verbs each.
    expect(resolvedCellCount).toBe(24);
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

  describe("state narrowing", () => {
    it("accepts the states its arm admits and refuses the rest", () => {
      expect(parseTeardownModerationState("quarantined")).toBe("quarantined");
      // ⚠️ `quarantined` is a real label on the shared enum and NOT reachable on this arm.
      expect(parseCaseStudyModerationState("quarantined")).toBeNull();
      expect(parseTeardownModerationState("rejected")).toBeNull();
      expect(parseTeardownModerationState("draft")).toBeNull();
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
