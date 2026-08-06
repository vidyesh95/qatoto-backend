import { describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();
vi.mock("#src/db/index.js", () => ({ db: {}, pool: {} }));
vi.mock("dotenv/config", () => ({}));

const { isOrderEligibleForCompletion, isProductLineEligibleForCompletion, isServiceEngagementEligibleForCompletion } =
  await import("#src/services/commerce-completion.service.js");

describe("commerce completion eligibility", () => {
  it("requires delivered product quantity and a terminal line balance", () => {
    expect(
      isProductLineEligibleForCompletion({
        quantityOrdered: 3,
        quantityFulfilled: 3,
        quantityCancelled: 0,
      }),
    ).toBe(true);
    expect(
      isProductLineEligibleForCompletion({
        quantityOrdered: 3,
        quantityFulfilled: 1,
        quantityCancelled: 2,
      }),
    ).toBe(true);
    expect(
      isProductLineEligibleForCompletion({
        quantityOrdered: 3,
        quantityFulfilled: 0,
        quantityCancelled: 3,
      }),
    ).toBe(false);
    expect(
      isProductLineEligibleForCompletion({
        quantityOrdered: 3,
        quantityFulfilled: 1,
        quantityCancelled: 0,
      }),
    ).toBe(false);
  });

  it("requires payment-confirmed, non-disputed orders", () => {
    expect(isOrderEligibleForCompletion("pending_payment")).toBe(false);
    expect(isOrderEligibleForCompletion("payment_processing")).toBe(false);
    expect(isOrderEligibleForCompletion("confirmed")).toBe(true);
    expect(isOrderEligibleForCompletion("in_fulfillment")).toBe(true);
    expect(isOrderEligibleForCompletion("partially_completed")).toBe(true);
    expect(isOrderEligibleForCompletion("completed")).toBe(true);
    expect(isOrderEligibleForCompletion("disputed")).toBe(false);
  });

  it("requires completed service work between different organizations", () => {
    expect(
      isServiceEngagementEligibleForCompletion({
        state: "completed",
        executionContractState: "ready",
        requiresDeliverableNormalization: false,
        buyerOrganizationId: "commerce_org_buyer",
        providerOrganizationId: "commerce_org_provider",
      }),
    ).toBe(true);
    expect(
      isServiceEngagementEligibleForCompletion({
        state: "in_progress",
        executionContractState: "ready",
        requiresDeliverableNormalization: false,
        buyerOrganizationId: "commerce_org_buyer",
        providerOrganizationId: "commerce_org_provider",
      }),
    ).toBe(false);
    expect(
      isServiceEngagementEligibleForCompletion({
        state: "completed",
        executionContractState: "ready",
        requiresDeliverableNormalization: false,
        buyerOrganizationId: "commerce_org_same",
        providerOrganizationId: "commerce_org_same",
      }),
    ).toBe(false);
    expect(
      isServiceEngagementEligibleForCompletion({
        state: "completed",
        executionContractState: "legacy_missing_snapshot",
        requiresDeliverableNormalization: false,
        buyerOrganizationId: "commerce_org_buyer",
        providerOrganizationId: "commerce_org_provider",
      }),
    ).toBe(false);
    expect(
      isServiceEngagementEligibleForCompletion({
        state: "completed",
        executionContractState: "ready",
        requiresDeliverableNormalization: true,
        buyerOrganizationId: "commerce_org_buyer",
        providerOrganizationId: "commerce_org_provider",
      }),
    ).toBe(false);
  });
});
