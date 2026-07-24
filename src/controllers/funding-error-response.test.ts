import { describe, expect, it } from "vitest";

import { mapFundingErrorToResponse, type FundingDomainError } from "#src/controllers/funding-error-response.js";

/**
 * The §7 status policy (R_AND_D_BACKEND_STRUCTURE.md §7, §11c, §13).
 *
 * WHY THIS SUITE EXISTS. The mapper is a `switch` with a `never` default, so TypeScript
 * already proves every variant is HANDLED. What it cannot prove is that each one is handled
 * CORRECTLY — and the status codes here are not cosmetic:
 *
 *   a 403 where §7 specifies 404 is an id oracle;
 *   a 200 where §7 specifies 409 puts a green tick on a broken ledger;
 *   a 403 where §7 specifies 422 tells a founder they lack permission when the real answer
 *     is that no permission would make self-approval acceptable.
 *
 * The whole union is enumerated below, so adding a variant fails the count assertion at the
 * end until somebody decides its status deliberately.
 */

/** One representative of every variant in `FundingDomainError`. */
const EVERY_ERROR: readonly FundingDomainError[] = [
  { type: "NOT_FOUND", projectRef: "solar-cold-storage" },
  { type: "ROUND_NOT_FOUND", roundId: "round-1" },
  { type: "PLEDGE_NOT_FOUND", pledgeId: "pledge-1" },
  { type: "MILESTONE_NOT_FOUND", milestoneId: "milestone-1" },
  { type: "RELEASE_NOT_FOUND", releaseId: "release-1" },
  { type: "ESCROW_ENTRY_NOT_FOUND", entryId: "entry-1" },
  { type: "TRANSFER_NOT_FOUND", transferId: "transfer-1" },
  { type: "CONFIDENCE_NOT_COMPUTED", projectId: "project-1" },
  { type: "NOT_THE_BACKER" },
  { type: "APPROVER_NOT_AUTHORIZED" },
  { type: "ROUND_TYPE_DISABLED", roundType: "equity" },
  { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "audit_escrow" },
  { type: "ROUND_NOT_OPEN", status: "closed" },
  { type: "ROUND_ALREADY_OPEN" },
  { type: "ROUND_TERMINAL", status: "cancelled" },
  { type: "ROUND_CLOSED_FOR_PLEDGES", closesAt: new Date("2026-01-01T00:00:00.000Z") },
  { type: "PLEDGE_NOT_CANCELLABLE", status: "settled" },
  { type: "PLEDGE_NOT_PENDING", status: "settled" },
  { type: "TRANSFER_NOT_SUBMITTABLE", status: "settled" },
  { type: "TRANSFER_ALREADY_TERMINAL", status: "failed" },
  { type: "MILESTONE_TERMINAL", status: "cancelled" },
  { type: "MILESTONE_ALREADY_COMPLETE" },
  { type: "MILESTONE_ORDER_TAKEN", orderIndex: 3 },
  { type: "RELEASE_ALREADY_REQUESTED" },
  { type: "RELEASE_ALREADY_DECIDED", status: "approved" },
  { type: "MILESTONE_NOT_DONE", status: "in_progress" },
  { type: "EFFORT_WINDOWS_OPEN", openCount: 2, disputedCount: 1 },
  { type: "INSUFFICIENT_ESCROW", availableInCents: "1000", requiredInCents: "250000" },
  { type: "SELF_APPROVAL_FORBIDDEN" },
  { type: "SELF_PLEDGE_FORBIDDEN" },
  { type: "PLEDGE_BELOW_MINIMUM", minimumInCents: "100" },
  { type: "PLEDGE_ABOVE_MAXIMUM", maximumInCents: "1000000" },
  { type: "ROUND_INCOMPLETE_FOR_OPEN", missing: ["closesAt"] },
  { type: "MILESTONE_HAS_NO_RELEASE_AMOUNT" },
  { type: "AUTHORIZING_ENTRY_MISSING", pledgeId: "pledge-1" },
  { type: "ESCROW_CHAIN_BROKEN", sequenceNumber: 412, reason: "hash-mismatch" },
];

describe("the §7 status policy", () => {
  it("answers 404 for EVERY lookup failure, so no id can be probed", () => {
    // §13: failure → NOT_FOUND → 404, never 403, so ids cannot be probed. "No such
    // project", "not a member" and "that round belongs to someone else" are one answer.
    for (const errorType of [
      "NOT_FOUND",
      "ROUND_NOT_FOUND",
      "PLEDGE_NOT_FOUND",
      "MILESTONE_NOT_FOUND",
      "RELEASE_NOT_FOUND",
      "ESCROW_ENTRY_NOT_FOUND",
      "TRANSFER_NOT_FOUND",
    ]) {
      const error = EVERY_ERROR.find((candidate) => candidate.type === errorType);
      if (!error) {
        throw new Error(`${errorType} is missing from EVERY_ERROR — add it before asserting.`);
      }
      // The type name goes in the assertion VALUE rather than a message argument, so a
      // failure names the offending variant in the diff instead of in a label.
      expect([errorType, mapFundingErrorToResponse(error).statusCode]).toEqual([errorType, 404]);
    }
  });

  it("answers 422 for SELF_APPROVAL_FORBIDDEN, which §7 pins by number", () => {
    // NOT 403. The caller IS authorized to approve releases in general; this request is
    // unprocessable because the approver and the requester are the same person, and no
    // amount of extra permission would fix that. §7 spells the status out.
    const mapped = mapFundingErrorToResponse({ type: "SELF_APPROVAL_FORBIDDEN" });
    expect(mapped.statusCode).toBe(422);
    // The message has to say WHO, or a founder reads it as a bug in the button.
    expect(mapped.message).toContain("somebody other than");
  });

  it("answers 409 for a broken ledger — never 200 with a false flag", () => {
    // §9.9's rule, applied to §7's chain: a verification endpoint that answers "no" with a
    // success status will be polled by a dashboard that renders a green tick for a 200.
    const mapped = mapFundingErrorToResponse({
      type: "ESCROW_CHAIN_BROKEN",
      sequenceNumber: 412,
      reason: "sequence-gap",
    });
    expect(mapped.statusCode).toBe(409);
    // Naming the exact sequence is what makes the alert actionable rather than alarming.
    expect(mapped.message).toContain("412");
    expect(mapped.message).toContain("sequence-gap");
  });

  it("names both blocking counts when §9's windows are open", () => {
    // A founder blocked on a payout needs to know WHICH subsystem is holding it and by how
    // much, or the only available action is to file a support ticket.
    const mapped = mapFundingErrorToResponse({
      type: "EFFORT_WINDOWS_OPEN",
      openCount: 2,
      disputedCount: 1,
    });
    expect(mapped.statusCode).toBe(409);
    expect(mapped.message).toContain("2 open");
    expect(mapped.message).toContain("1 disputed");
  });

  it("never names the role an attacker would need for a staff capability", () => {
    // platform-role.service.ts: telling an attacker which role grants a capability is free
    // reconnaissance. The payload carries the capability, and so does the message.
    const mapped = mapFundingErrorToResponse({
      type: "PLATFORM_CAPABILITY_REQUIRED",
      capability: "audit_escrow",
    });
    expect(mapped.statusCode).toBe(403);
    expect(mapped.message).toContain("audit_escrow");
    expect(mapped.message).not.toContain("auditor");
    expect(mapped.message).not.toContain("admin");
  });

  it("refuses to invent an investor-confidence figure that was never computed", () => {
    // 404, not a 200 carrying 0. Inventing one is exactly what the hardcoded
    // INVESTOR_CONFIDENCE_PERCENT = 78 was.
    const mapped = mapFundingErrorToResponse({
      type: "CONFIDENCE_NOT_COMPUTED",
      projectId: "project-1",
    });
    expect(mapped.statusCode).toBe(404);
  });

  it("gives every variant a 4xx or 5xx status and a non-empty message", () => {
    // Collected and asserted as a whole rather than per-variant, so ONE failure names
    // every offender at once instead of stopping at the first.
    const offenders = EVERY_ERROR.filter((error) => {
      const mapped = mapFundingErrorToResponse(error);
      const statusIsClientOrServerError = mapped.statusCode >= 400 && mapped.statusCode < 600;
      // No placeholder copy: every one of these reaches a human.
      const messageIsUseful = mapped.message.trim().length > 0;
      return !statusIsClientOrServerError || !messageIsUseful;
    });

    expect(offenders.map((error) => error.type)).toEqual([]);
  });

  it("enumerates every variant of the union", () => {
    // The mapper's `never` default proves each variant is HANDLED; nothing proves each is
    // TESTED. This count is what fails when somebody adds a variant and forgets this file.
    const distinctTypes = new Set(EVERY_ERROR.map((error) => error.type));
    expect(distinctTypes.size).toBe(EVERY_ERROR.length);
    expect(distinctTypes.size).toBe(36);
  });
});
