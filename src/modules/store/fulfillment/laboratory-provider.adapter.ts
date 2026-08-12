import { randomUUID } from "node:crypto";

import { config } from "#src/config/index.js";
import type { Result } from "#src/types/index.js";

/**
 * Testing, inspection and certification adapter seam
 * (STORE_BACKEND_STRUCTURE.md §3, Phase 14c).
 *
 * The connector behind SGS, Bureau Veritas, TÜV and Intertek — the partners Alibaba uses for
 * supplier verification and pre-shipment inspection, and the one category where there is no
 * marketplace API to copy, only each laboratory's own.
 *
 * ## A REPORT IS EVIDENCE, NOT A VERDICT QATOTO ISSUES
 *
 * §15.3's rule about compatibility claims applies with more force here. A laboratory says a
 * sample met a standard; Qatoto records that the laboratory said it. The platform never
 * derives a pass from a measurement, never summarises a report into a badge, and never
 * lets an inspection result promote a seller — those are the accredited body's conclusions
 * and its accreditation is what makes them worth anything.
 *
 * This is also why `submitSample` and `retrieveReport` are separate calls with a real gap
 * between them. Physical testing takes days; an adapter that returned a result from the
 * submission would be modelling something that cannot happen.
 *
 * ## What is NOT wired
 *
 * A seam only. No laboratory is contracted and nothing calls it.
 * `testing_certification_offering_detail` and `inspection_offering_detail` describe what a
 * provider offers; a delivered report lands as an encrypted document and is therefore
 * subject to Phase 14b's scanner like every other upload.
 */

export const LABORATORY_PROVIDER_NAMES = ["fake"] as const;

export type LaboratoryProviderName = (typeof LABORATORY_PROVIDER_NAMES)[number];

export type LaboratoryProviderError =
  | { type: "PROVIDER_UNAVAILABLE"; reason: string }
  | { type: "PROVIDER_REJECTED"; reason: string }
  | { type: "STANDARD_NOT_OFFERED"; standardCode: string }
  | { type: "REPORT_NOT_READY"; providerTestRef: string };

export type NormalizedTestState =
  | "requested"
  | "awaiting_sample"
  | "sample_received"
  | "in_progress"
  | "report_available"
  | "cancelled";

/**
 * What the laboratory concluded, in its vocabulary and not ours.
 *
 * `inconclusive` is a real outcome and is kept distinct from `failed`: a sample that
 * degraded in transit has not failed a standard, and recording it as a failure would put a
 * mark against a seller that the laboratory did not make.
 */
export type NormalizedTestOutcome = "passed" | "failed" | "inconclusive";

export interface RequestLaboratoryTestInput {
  readonly idempotencyKey: string;
  readonly engagementId: string;
  /** e.g. `EN 71-3`, `ISO 9001`, `RoHS`. The laboratory's identifier, not a Qatoto slug. */
  readonly standardCodes: readonly string[];
  readonly sampleDescription: string;
  readonly laboratoryLocationHint: string | null;
}

export interface LaboratoryTestResult {
  readonly providerTestRef: string;
  readonly state: NormalizedTestState;
  readonly standardCodes: readonly string[];
  readonly expectedReportBy: Date | null;
}

export interface SubmitSampleInput {
  readonly idempotencyKey: string;
  readonly providerTestRef: string;
  /** The carrier reference the sample travelled under, so the laboratory can match it. */
  readonly inboundTrackingNumber: string | null;
}

export interface LaboratoryReport {
  readonly providerTestRef: string;
  readonly providerReportRef: string;
  readonly outcome: NormalizedTestOutcome;
  /**
   * Where the laboratory's own PDF can be fetched. A short-lived URL, never stored — the
   * report is downloaded into an encrypted document and the URL is discarded, because a
   * long-lived link to an accredited report is a credential.
   */
  readonly reportDownloadUrl: string;
  readonly issuedAt: Date;
  readonly accreditationBody: string | null;
}

export interface LaboratoryProviderAdapter {
  readonly providerName: LaboratoryProviderName;
  requestTest(
    input: RequestLaboratoryTestInput,
  ): Promise<Result<LaboratoryTestResult, LaboratoryProviderError>>;
  submitSample(
    input: SubmitSampleInput,
  ): Promise<Result<LaboratoryTestResult, LaboratoryProviderError>>;
  retrieveReport(
    providerTestRef: string,
  ): Promise<Result<LaboratoryReport, LaboratoryProviderError>>;
}

/** Deterministic fake. It never produces a report, and that is the honest behaviour. */
export class FakeLaboratoryProviderAdapter implements LaboratoryProviderAdapter {
  readonly providerName = "fake" as const;

  async requestTest(
    input: RequestLaboratoryTestInput,
  ): Promise<Result<LaboratoryTestResult, LaboratoryProviderError>> {
    if (input.standardCodes.length === 0) {
      return {
        success: false,
        error: { type: "PROVIDER_REJECTED", reason: "at_least_one_standard_required" },
      };
    }
    const unsupported = input.standardCodes.find((code) => code.trim().length === 0);
    if (unsupported !== undefined) {
      return { success: false, error: { type: "STANDARD_NOT_OFFERED", standardCode: unsupported } };
    }
    return {
      success: true,
      value: {
        providerTestRef: `fake_lab_${input.idempotencyKey}`,
        state: "awaiting_sample",
        standardCodes: input.standardCodes,
        expectedReportBy: null,
      },
    };
  }

  async submitSample(
    input: SubmitSampleInput,
  ): Promise<Result<LaboratoryTestResult, LaboratoryProviderError>> {
    if (!input.providerTestRef.startsWith("fake_lab_")) {
      return {
        success: false,
        error: { type: "PROVIDER_UNAVAILABLE", reason: "unknown_test_reference" },
      };
    }
    return {
      success: true,
      value: {
        providerTestRef: input.providerTestRef,
        state: "sample_received",
        standardCodes: [],
        expectedReportBy: null,
      },
    };
  }

  async retrieveReport(
    providerTestRef: string,
  ): Promise<Result<LaboratoryReport, LaboratoryProviderError>> {
    if (!providerTestRef.startsWith("fake_lab_")) {
      return {
        success: false,
        error: { type: "PROVIDER_UNAVAILABLE", reason: "unknown_test_reference" },
      };
    }
    /**
     * ALWAYS `REPORT_NOT_READY`, and never a synthetic pass.
     *
     * Every other fake in this phase returns a benign success because the thing it stands in
     * for is a state transition. A laboratory report is not a state transition — it is an
     * accredited body's conclusion about a physical object, and a fixture that answered
     * "passed" would be a fabricated certification. If that value ever reached a seller
     * profile or a buyer's screen it would be a false compliance claim, which is the one
     * category of fake output that cannot be made safe by a comment.
     */
    return { success: false, error: { type: "REPORT_NOT_READY", providerTestRef } };
  }
}

export function mintLaboratoryIdempotencyKey(purpose: "test" | "sample"): string {
  return `laboratory_${purpose}_${randomUUID()}`;
}

export function resolveLaboratoryProvider(
  providerSlug: string,
): Result<LaboratoryProviderAdapter, LaboratoryProviderError> {
  if (providerSlug !== "fake") {
    return {
      success: false,
      error: {
        type: "PROVIDER_UNAVAILABLE",
        reason: `Laboratory provider "${providerSlug}" is not implemented yet.`,
      },
    };
  }
  if (config.NODE_ENV === "production") {
    return {
      success: false,
      error: {
        type: "PROVIDER_UNAVAILABLE",
        reason:
          'The "fake" laboratory provider is refuse-closed in production; no accredited body stands behind anything it returns.',
      },
    };
  }
  return { success: true, value: new FakeLaboratoryProviderAdapter() };
}
