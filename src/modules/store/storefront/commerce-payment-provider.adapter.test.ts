import { afterEach, describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

/**
 * The Razorpay refusals in `resolveCommercePaymentProvider` (Store Phase 5).
 *
 * These are the only thing standing between a misconfigured deployment and Qatoto holding
 * buyer money in its own merchant account, so each one is pinned: production is refused
 * regardless of keys, a live key is refused regardless of environment, and missing keys are a
 * Result rather than a boot crash.
 *
 * `config` is parsed once at import, so every case resets the module graph and re-imports
 * under its own environment.
 */

vi.mock("dotenv/config", () => ({}));

const TEST_KEYS = {
  COMMERCE_PAYMENT_PROVIDER: "razorpay",
  RAZORPAY_KEY_ID: "rzp_test_ResolverSuite",
  RAZORPAY_KEY_SECRET: "resolver_suite_secret",
};

async function resolveUnder(overrides: Readonly<Record<string, string>>) {
  vi.resetModules();
  stubServerEnvironment(overrides);
  const { resolveCommercePaymentProvider } =
    await import("#src/modules/store/storefront/commerce-payment-provider.adapter.js");
  return resolveCommercePaymentProvider();
}

describe("resolveCommercePaymentProvider · razorpay", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves the Razorpay adapter for test keys outside production", async () => {
    const resolved = await resolveUnder(TEST_KEYS);

    expect(resolved.success ? resolved.value.providerName : resolved.error.type).toBe("razorpay");
  });

  it.each([
    {
      name: "production, even with test keys",
      overrides: { ...TEST_KEYS, NODE_ENV: "production", TZ: "UTC" },
      reasonPattern: /refuse-closed in production/,
    },
    {
      name: "a live key outside production",
      overrides: { ...TEST_KEYS, RAZORPAY_KEY_ID: "rzp_live_ShouldNeverMoveMoney" },
      reasonPattern: /Only Razorpay test keys/,
    },
    {
      name: "missing keys",
      overrides: { COMMERCE_PAYMENT_PROVIDER: "razorpay" },
      reasonPattern: /RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required/,
    },
  ])("refuses $name", async ({ overrides, reasonPattern }) => {
    const resolved = await resolveUnder(overrides);

    expect(resolved.success ? null : resolved.error.type).toBe("PROVIDER_UNAVAILABLE");
    expect(resolved.success ? "" : JSON.stringify(resolved.error)).toMatch(reasonPattern);
  });
});
