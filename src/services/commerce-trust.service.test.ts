import { describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();
vi.mock("#src/db/index.js", () => ({ db: {}, pool: {} }));
vi.mock("dotenv/config", () => ({}));

const { evaluateDisputeOpeningRelationship, evaluateReviewRelationship, isModeratorMemberOfDisputeParty } =
  await import("#src/services/commerce-trust.service.js");

describe("commerce trust relationship policy", () => {
  it("allows only the completion buyer to review a different counterparty", () => {
    expect(
      evaluateReviewRelationship({
        actorOrganizationId: "commerce_org_buyer",
        buyerOrganizationId: "commerce_org_buyer",
        counterpartyOrganizationId: "commerce_org_seller",
      }),
    ).toBe("eligible");
    expect(
      evaluateReviewRelationship({
        actorOrganizationId: "commerce_org_outsider",
        buyerOrganizationId: "commerce_org_buyer",
        counterpartyOrganizationId: "commerce_org_seller",
      }),
    ).toBe("not_found");
    expect(
      evaluateReviewRelationship({
        actorOrganizationId: "commerce_org_same",
        buyerOrganizationId: "commerce_org_same",
        counterpartyOrganizationId: "commerce_org_same",
      }),
    ).toBe("self_review");
  });

  it("conceals unrelated orders and restricts dispute opening to the buyer", () => {
    expect(
      evaluateDisputeOpeningRelationship({
        actorOrganizationId: "commerce_org_outsider",
        buyerOrganizationId: "commerce_org_buyer",
        counterpartyOrganizationId: "commerce_org_seller",
        orderState: "confirmed",
      }),
    ).toBe("not_found");
    expect(
      evaluateDisputeOpeningRelationship({
        actorOrganizationId: "commerce_org_seller",
        buyerOrganizationId: "commerce_org_buyer",
        counterpartyOrganizationId: "commerce_org_seller",
        orderState: "confirmed",
      }),
    ).toBe("forbidden");
    expect(
      evaluateDisputeOpeningRelationship({
        actorOrganizationId: "commerce_org_same",
        buyerOrganizationId: "commerce_org_same",
        counterpartyOrganizationId: "commerce_org_same",
        orderState: "confirmed",
      }),
    ).toBe("forbidden");
    expect(
      evaluateDisputeOpeningRelationship({
        actorOrganizationId: "commerce_org_buyer",
        buyerOrganizationId: "commerce_org_buyer",
        counterpartyOrganizationId: "commerce_org_seller",
        orderState: "confirmed",
      }),
    ).toBe("eligible");
  });

  it("rejects disputes before payment and while an order is already frozen", () => {
    const invalidOrderStates: readonly ("pending_payment" | "payment_processing" | "cancelled" | "disputed")[] = [
      "pending_payment",
      "payment_processing",
      "cancelled",
      "disputed",
    ];
    for (const orderState of invalidOrderStates) {
      expect(
        evaluateDisputeOpeningRelationship({
          actorOrganizationId: "commerce_org_buyer",
          buyerOrganizationId: "commerce_org_buyer",
          counterpartyOrganizationId: "commerce_org_seller",
          orderState,
        }),
      ).toBe("invalid_state");
    }
  });

  it("excludes moderators belonging to either dispute party", () => {
    const disputeParties = {
      buyerOrganizationId: "commerce_org_buyer",
      counterpartyOrganizationId: "commerce_org_seller",
    };
    expect(
      isModeratorMemberOfDisputeParty({
        ...disputeParties,
        moderatorOrganizationIds: ["commerce_org_buyer"],
      }),
    ).toBe(true);
    expect(
      isModeratorMemberOfDisputeParty({
        ...disputeParties,
        moderatorOrganizationIds: ["commerce_org_seller"],
      }),
    ).toBe(true);
    expect(
      isModeratorMemberOfDisputeParty({
        ...disputeParties,
        moderatorOrganizationIds: ["commerce_org_moderator"],
      }),
    ).toBe(false);
  });
});
