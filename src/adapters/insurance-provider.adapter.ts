import { randomUUID } from "node:crypto";

import { config } from "#src/config/index.js";
import type { Result } from "#src/types/index.js";

/**
 * Cargo insurance adapter seam (STORE_BACKEND_STRUCTURE.md §3, Phase 14c).
 *
 * ## The §14 boundary this adapter sits against
 *
 * "Insurance solicitation/licensing boundaries" is an OPEN legal question, and it is not the
 * same question as escrow custody. Brokering insurance is a regulated activity in most
 * jurisdictions Qatoto would operate in, and quoting a policy is part of that activity — not
 * a technical detail downstream of it.
 *
 * So this seam is deliberately narrow. It requests a quote from a licensed insurer, binds a
 * policy the INSURER issues, and reads back what the insurer says. It never rates a risk,
 * never computes a premium, and never presents an unbound quote as coverage. Qatoto is
 * plumbing between a buyer and an insurer, exactly as it is plumbing between a buyer and an
 * escrow holder.
 *
 * ## What is NOT wired
 *
 * A seam only. No insurer is contracted, nothing calls it, and no client copy may claim a
 * shipment is insured. `insurance_offering_detail` and the engagement deliverable tables are
 * where a bound policy would land.
 */

export const INSURANCE_PROVIDER_NAMES = ["fake"] as const;

export type InsuranceProviderName = (typeof INSURANCE_PROVIDER_NAMES)[number];

export type InsuranceProviderError =
  | { type: "PROVIDER_UNAVAILABLE"; reason: string }
  | { type: "PROVIDER_REJECTED"; reason: string }
  | { type: "QUOTE_EXPIRED"; providerQuoteRef: string }
  | { type: "POLICY_NOT_CANCELLABLE"; providerPolicyRef: string };

export type NormalizedPolicyState = "quoted" | "bound" | "active" | "expired" | "cancelled";

export interface RequestInsuranceQuoteInput {
  readonly idempotencyKey: string;
  /** What the goods are worth, which is what a cargo policy indemnifies against. */
  readonly insuredValueInCents: number;
  readonly currency: string;
  readonly originCountryCode: string;
  readonly destinationCountryCode: string;
  readonly commodityDescription: string;
}

export interface InsuranceQuoteResult {
  readonly providerQuoteRef: string;
  readonly premiumInCents: number;
  readonly currency: string;
  readonly coverageLimitInCents: number;
  /**
   * The insurer's own exclusions, verbatim and unedited.
   *
   * A SUMMARY WOULD BE A MISREPRESENTATION. What a cargo policy does not cover is the part
   * a buyer is most likely to be surprised by, and paraphrasing an insurer's exclusions into
   * friendlier copy is how a platform acquires liability it never priced.
   */
  readonly exclusionsText: string;
  readonly state: NormalizedPolicyState;
  readonly quoteExpiresAt: Date;
}

export interface BindPolicyInput {
  readonly idempotencyKey: string;
  readonly providerQuoteRef: string;
  readonly insuredOrganizationLegalName: string;
}

export interface PolicyResult {
  readonly providerPolicyRef: string;
  readonly state: NormalizedPolicyState;
  readonly coverageLimitInCents: number;
  readonly currency: string;
  readonly coverageStartsAt: Date | null;
  readonly coverageEndsAt: Date | null;
}

export interface InsuranceProviderAdapter {
  readonly providerName: InsuranceProviderName;
  requestQuote(
    input: RequestInsuranceQuoteInput,
  ): Promise<Result<InsuranceQuoteResult, InsuranceProviderError>>;
  bindPolicy(input: BindPolicyInput): Promise<Result<PolicyResult, InsuranceProviderError>>;
  retrievePolicy(
    providerPolicyRef: string,
  ): Promise<Result<PolicyResult, InsuranceProviderError>>;
  cancelPolicy(providerPolicyRef: string): Promise<Result<PolicyResult, InsuranceProviderError>>;
}

/** Deterministic fake. A flat 1% premium, obviously synthetic rather than plausibly rated. */
export class FakeInsuranceProviderAdapter implements InsuranceProviderAdapter {
  readonly providerName = "fake" as const;

  async requestQuote(
    input: RequestInsuranceQuoteInput,
  ): Promise<Result<InsuranceQuoteResult, InsuranceProviderError>> {
    if (input.insuredValueInCents <= 0) {
      return {
        success: false,
        error: { type: "PROVIDER_REJECTED", reason: "insured_value_must_be_positive" },
      };
    }
    if (input.commodityDescription.trim().length === 0) {
      return {
        success: false,
        error: { type: "PROVIDER_REJECTED", reason: "commodity_description_required" },
      };
    }
    return {
      success: true,
      value: {
        providerQuoteRef: `fake_ins_${input.idempotencyKey}`,
        // Integer arithmetic, rounded up: a premium is what the insurer charges, and
        // rounding a fraction of a cent in the insurer's favour is the safe direction.
        premiumInCents: Math.ceil(input.insuredValueInCents / 100),
        currency: input.currency,
        coverageLimitInCents: input.insuredValueInCents,
        exclusionsText:
          "SYNTHETIC FIXTURE — no coverage exists. A real insurer's exclusions are stored verbatim.",
        state: "quoted",
        quoteExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    };
  }

  async bindPolicy(input: BindPolicyInput): Promise<Result<PolicyResult, InsuranceProviderError>> {
    if (!input.providerQuoteRef.startsWith("fake_ins_")) {
      return {
        success: false,
        error: { type: "PROVIDER_UNAVAILABLE", reason: "unknown_quote_reference" },
      };
    }
    /**
     * `bound`, not `active`. Cover incepts when the insurer says it does — usually at
     * departure — and a platform deciding that for itself would be telling a buyer they are
     * covered during a window the insurer has not agreed to.
     */
    return {
      success: true,
      value: {
        providerPolicyRef: `fake_pol_${input.idempotencyKey}`,
        state: "bound",
        coverageLimitInCents: 0,
        currency: "USD",
        coverageStartsAt: null,
        coverageEndsAt: null,
      },
    };
  }

  async retrievePolicy(
    providerPolicyRef: string,
  ): Promise<Result<PolicyResult, InsuranceProviderError>> {
    if (!providerPolicyRef.startsWith("fake_pol_")) {
      return {
        success: false,
        error: { type: "PROVIDER_UNAVAILABLE", reason: "unknown_policy_reference" },
      };
    }
    return {
      success: true,
      value: {
        providerPolicyRef,
        state: "bound",
        coverageLimitInCents: 0,
        currency: "USD",
        coverageStartsAt: null,
        coverageEndsAt: null,
      },
    };
  }

  async cancelPolicy(
    providerPolicyRef: string,
  ): Promise<Result<PolicyResult, InsuranceProviderError>> {
    if (!providerPolicyRef.startsWith("fake_pol_")) {
      return {
        success: false,
        error: { type: "PROVIDER_UNAVAILABLE", reason: "unknown_policy_reference" },
      };
    }
    return {
      success: true,
      value: {
        providerPolicyRef,
        state: "cancelled",
        coverageLimitInCents: 0,
        currency: "USD",
        coverageStartsAt: null,
        coverageEndsAt: null,
      },
    };
  }
}

export function mintInsuranceIdempotencyKey(purpose: "quote" | "bind" | "cancel"): string {
  return `insurance_${purpose}_${randomUUID()}`;
}

export function resolveInsuranceProvider(
  providerSlug: string,
): Result<InsuranceProviderAdapter, InsuranceProviderError> {
  if (providerSlug !== "fake") {
    return {
      success: false,
      error: {
        type: "PROVIDER_UNAVAILABLE",
        reason: `Insurance provider "${providerSlug}" is not implemented yet.`,
      },
    };
  }
  if (config.NODE_ENV === "production") {
    return {
      success: false,
      error: {
        type: "PROVIDER_UNAVAILABLE",
        reason:
          'The "fake" insurance provider is refuse-closed in production. Nothing is insured by it, and §14 has not settled the solicitation and licensing boundary.',
      },
    };
  }
  return { success: true, value: new FakeInsuranceProviderAdapter() };
}
