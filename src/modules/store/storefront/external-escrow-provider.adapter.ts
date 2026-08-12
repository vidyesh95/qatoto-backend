import { randomUUID } from "node:crypto";

import { z } from "zod";

import { config } from "#src/config/index.js";
import { verifyWebhookSignature } from "#src/lib/webhook-signature.js";
import type { Result } from "#src/types/index.js";

/**
 * External escrow provider adapter seam (STORE_BACKEND_STRUCTURE.md §3, Phase 14).
 *
 * QATOTO PROVIDES NO ESCROW AND NEVER HOLDS FUNDS. Where risk is to be reduced, a
 * LICENSED THIRD PARTY holds the money — Escrow.com, Shieldpay, a regional gateway —
 * and this interface is the only way the rest of the backend speaks to one. Buyer and
 * seller choose the provider between themselves (`commerce-settlement.service.ts`);
 * nothing here selects one for them.
 *
 * THE RULE THAT GOVERNS EVERY METHOD BELOW: our books follow the provider and never
 * lead it. `requestRelease` is a REQUEST. It returns when the provider has accepted the
 * instruction, which is not the same as the money having moved, and it posts nothing to
 * the journal. Only a normalized event — delivered by webhook, or pulled by the
 * reconciler through `retrieveSession` — moves a balance.
 *
 * The fake implementation exists so the whole path can be exercised end to end without a
 * provider contract. NO MONEY MOVES THROUGH IT. Do not ship client copy that says funds
 * are held or protected while it is the configured provider.
 */

/**
 * Closed set, parsed from `commerce_external_provider.provider_slug` at the boundary
 * rather than being a database enum. Adding a provider is then an INSERT plus an adapter
 * rather than a migration, while the switch that dispatches on it stays exhaustive.
 */
export const EXTERNAL_ESCROW_PROVIDER_NAMES = ["fake", "escrow_com", "shieldpay"] as const;

export type ExternalEscrowProviderName = (typeof EXTERNAL_ESCROW_PROVIDER_NAMES)[number];

export function parseExternalEscrowProviderName(
  candidate: string,
): Result<ExternalEscrowProviderName, EscrowProviderError> {
  const match = EXTERNAL_ESCROW_PROVIDER_NAMES.find((name) => name === candidate);
  if (match === undefined) {
    return {
      success: false,
      error: { type: "PROVIDER_UNAVAILABLE", reason: `Unknown escrow provider "${candidate}".` },
    };
  }
  return { success: true, value: match };
}

export type EscrowProviderError =
  | { type: "PROVIDER_UNAVAILABLE"; reason: string }
  | { type: "PROVIDER_REJECTED"; reason: string }
  | { type: "PROVIDER_NOT_FOUND"; providerRef: string }
  | { type: "MILESTONE_NOT_RELEASABLE"; providerMilestoneRef: string }
  | { type: "SIGNATURE_INVALID"; reason: string };

/**
 * What the provider says, normalized — and the SCHEMA IS THE DEFINITION. Every type in
 * this section is `z.infer`red from the parser that validates the wire, so there is no
 * hand-written parallel interface to drift from it (CLAUDE.md §3.1). Drift here would
 * surface as a webhook that parses and then fails to move money, which is the worst
 * possible place to discover a duplicated type.
 *
 * The vocabulary is deliberately smaller than any real provider's: every state has to
 * mean the same thing across Escrow.com, Shieldpay and whatever comes third, or the
 * ledger would be interpreting provider dialects.
 */
const MoneyAmountSchema = z.number().int().positive();
const CurrencySchema = z.string().regex(/^[A-Z]{3}$/, "Currency must be an ISO-4217 alpha-3 code");
const ProviderRefSchema = z.string().min(1).max(200);

const NormalizedEscrowSessionStateSchema = z.enum([
  "awaiting_agreement",
  "awaiting_funding",
  "funded",
  "partially_released",
  "released",
  "refunded",
  "cancelled",
  "disputed",
]);
export type NormalizedEscrowSessionState = z.infer<typeof NormalizedEscrowSessionStateSchema>;

const NormalizedEscrowMilestoneStateSchema = z.enum([
  "locked",
  "verification_pending",
  "verification_failed",
  "release_requested",
  "released",
  "refunded",
  "cancelled",
]);
export type NormalizedEscrowMilestoneState = z.infer<typeof NormalizedEscrowMilestoneStateSchema>;

/** Letter-of-credit shaped, per §3 — the closest real analogue to a neutral holder. */
export type EscrowMilestoneKind = "deposit" | "shipment" | "inspection" | "delivery" | "final";

/**
 * Which record proved a milestone. Every member names something this backend already
 * keeps, so escrow never acquires a private second opinion about whether a thing shipped.
 */
export type EscrowVerificationSourceKind =
  | "order_confirmed"
  | "shipment_leg_event"
  | "inspection_engagement"
  | "order_completion";

export interface EscrowMilestonePlanEntry {
  readonly milestoneId: string;
  readonly sequence: number;
  readonly milestoneKind: EscrowMilestoneKind;
  readonly amountInCents: number;
  readonly releaseConditionNote: string | null;
}

export interface CreateEscrowSessionInput {
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly orderId: string;
  readonly currency: string;
  readonly totalInCents: number;
  readonly buyerOrganizationLegalName: string;
  readonly sellerOrganizationLegalName: string;
  readonly escrowFeeBearer: "buyer" | "seller" | "split";
  readonly milestones: readonly EscrowMilestonePlanEntry[];
}

export interface EscrowSessionResult {
  readonly providerSessionRef: string;
  readonly state: NormalizedEscrowSessionState;
  /** Where the BUYER funds the session — the provider's page, never ours. */
  readonly hostedActionUrl: string | null;
  readonly milestones: readonly EscrowProviderMilestoneResult[];
}

export interface EscrowProviderMilestoneResult {
  readonly providerMilestoneRef: string;
  readonly sequence: number;
  readonly state: NormalizedEscrowMilestoneState;
}

export interface LockEscrowMilestonesInput {
  readonly idempotencyKey: string;
  readonly providerSessionRef: string;
  readonly milestones: readonly EscrowMilestonePlanEntry[];
}

export interface SubmitEscrowVerificationInput {
  readonly idempotencyKey: string;
  readonly providerSessionRef: string;
  readonly providerMilestoneRef: string;
  readonly sourceKind: EscrowVerificationSourceKind;
  readonly sourceId: string;
  readonly evidenceSummary: string;
}

export interface RequestEscrowReleaseInput {
  readonly idempotencyKey: string;
  readonly providerSessionRef: string;
  readonly providerMilestoneRef: string;
  readonly amountInCents: number;
  readonly currency: string;
}

export interface RequestEscrowRefundInput {
  readonly idempotencyKey: string;
  readonly providerSessionRef: string;
  readonly providerMilestoneRef: string;
  readonly amountInCents: number;
  readonly currency: string;
  readonly reason: string;
}

export interface EscrowMilestoneResult {
  readonly providerMilestoneRef: string;
  readonly state: NormalizedEscrowMilestoneState;
  readonly failureReason: string | null;
}

/**
 * The inbound event union, and the parser for it. Discriminated on `kind` so every
 * consumer's switch takes a `never` exhaustiveness default (CLAUDE.md §3.2) and a provider
 * adding an event type cannot be silently dropped.
 *
 * `.strict()` on every member matters more here than at an ordinary boundary: a provider
 * quietly adding a field to a release event should be a loud rejection we investigate, not
 * a field we ignore while moving the money the rest of the payload describes.
 */
export const NormalizedEscrowEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("session_state_changed"),
      providerSessionRef: ProviderRefSchema,
      state: NormalizedEscrowSessionStateSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("session_funded"),
      providerSessionRef: ProviderRefSchema,
      fundedAmountInCents: MoneyAmountSchema,
      currency: CurrencySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("milestone_state_changed"),
      providerSessionRef: ProviderRefSchema,
      providerMilestoneRef: ProviderRefSchema,
      state: NormalizedEscrowMilestoneStateSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("milestone_released"),
      providerSessionRef: ProviderRefSchema,
      providerMilestoneRef: ProviderRefSchema,
      releasedAmountInCents: MoneyAmountSchema,
      currency: CurrencySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("milestone_refunded"),
      providerSessionRef: ProviderRefSchema,
      providerMilestoneRef: ProviderRefSchema,
      refundedAmountInCents: MoneyAmountSchema,
      currency: CurrencySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("dispute_opened"),
      providerSessionRef: ProviderRefSchema,
      providerReason: z.string().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("dispute_resolved"),
      providerSessionRef: ProviderRefSchema,
      outcome: z.enum(["released", "refunded", "split"]),
    })
    .strict(),
]);

export type NormalizedEscrowEvent = z.infer<typeof NormalizedEscrowEventSchema>;

const EscrowWebhookEnvelopeSchema = z
  .object({
    providerEventId: z.string().min(1).max(200),
    eventType: z.string().min(1).max(120),
    event: NormalizedEscrowEventSchema,
  })
  .strict();

export interface ParsedEscrowWebhook {
  /** Deduplicates replay through `commerce_connector_webhook_event`'s unique index. */
  readonly providerEventId: string;
  /** The provider's own type string, stored verbatim for audit. */
  readonly eventType: string;
  readonly event: NormalizedEscrowEvent;
}

export interface ExternalEscrowProviderAdapter {
  readonly providerName: ExternalEscrowProviderName;

  createSession(
    input: CreateEscrowSessionInput,
  ): Promise<Result<EscrowSessionResult, EscrowProviderError>>;

  lockMilestones(
    input: LockEscrowMilestonesInput,
  ): Promise<Result<readonly EscrowProviderMilestoneResult[], EscrowProviderError>>;

  submitVerification(
    input: SubmitEscrowVerificationInput,
  ): Promise<Result<EscrowMilestoneResult, EscrowProviderError>>;

  requestRelease(
    input: RequestEscrowReleaseInput,
  ): Promise<Result<EscrowMilestoneResult, EscrowProviderError>>;

  requestRefund(
    input: RequestEscrowRefundInput,
  ): Promise<Result<EscrowMilestoneResult, EscrowProviderError>>;

  retrieveSession(
    providerSessionRef: string,
  ): Promise<Result<EscrowSessionResult, EscrowProviderError>>;

  /**
   * Signature verification lives in the ADAPTER, not the controller, because the scheme
   * is provider-specific and a controller that knew all of them would be the one place a
   * new provider could weaken every other one.
   */
  parseWebhook(
    rawBody: Buffer,
    headers: Readonly<Record<string, string | undefined>>,
    signingSecret: string,
  ): Result<ParsedEscrowWebhook, EscrowProviderError>;
}

const FAKE_SESSION_PREFIX = "fake_es_";
const FAKE_MILESTONE_PREFIX = "fake_em_";

/**
 * Deterministic fake. Provider refs derive from OUR idempotency keys, so a retried worker
 * call yields the same reference and never looks like a second session.
 *
 * IT DOES NOT AUTO-ADVANCE. `createSession` answers `awaiting_funding`, and nothing
 * becomes `funded` or `released` until an event is delivered to the webhook route. That
 * is the opposite of the fake payment adapter, which settles instantly — and the
 * difference is the point. Escrow's whole risk is a state machine driven from outside
 * this backend, so a fake that advanced itself would exercise a flow that cannot happen
 * and would hide every ordering bug the real thing will produce.
 */
export class FakeExternalEscrowProviderAdapter implements ExternalEscrowProviderAdapter {
  readonly providerName = "fake" as const;

  async createSession(
    input: CreateEscrowSessionInput,
  ): Promise<Result<EscrowSessionResult, EscrowProviderError>> {
    if (input.totalInCents <= 0) {
      return {
        success: false,
        error: { type: "PROVIDER_REJECTED", reason: "total_must_be_positive" },
      };
    }
    if (input.milestones.length === 0) {
      return {
        success: false,
        error: { type: "PROVIDER_REJECTED", reason: "milestone_plan_required" },
      };
    }

    const milestoneSum = input.milestones.reduce(
      (runningTotal, milestone) => runningTotal + milestone.amountInCents,
      0,
    );
    if (milestoneSum !== input.totalInCents) {
      return {
        success: false,
        error: { type: "PROVIDER_REJECTED", reason: "milestones_do_not_sum_to_total" },
      };
    }

    return {
      success: true,
      value: {
        providerSessionRef: `${FAKE_SESSION_PREFIX}${input.idempotencyKey}`,
        state: "awaiting_funding",
        hostedActionUrl: `https://escrow.invalid/fake/${input.sessionId}`,
        milestones: input.milestones.map((milestone) => ({
          providerMilestoneRef: `${FAKE_MILESTONE_PREFIX}${input.sessionId}_${milestone.sequence}`,
          sequence: milestone.sequence,
          state: "locked" as const,
        })),
      },
    };
  }

  async lockMilestones(
    input: LockEscrowMilestonesInput,
  ): Promise<Result<readonly EscrowProviderMilestoneResult[], EscrowProviderError>> {
    if (!input.providerSessionRef.startsWith(FAKE_SESSION_PREFIX)) {
      return {
        success: false,
        error: { type: "PROVIDER_NOT_FOUND", providerRef: input.providerSessionRef },
      };
    }
    return {
      success: true,
      value: input.milestones.map((milestone) => ({
        providerMilestoneRef: `${FAKE_MILESTONE_PREFIX}${input.providerSessionRef}_${milestone.sequence}`,
        sequence: milestone.sequence,
        state: "locked" as const,
      })),
    };
  }

  async submitVerification(
    input: SubmitEscrowVerificationInput,
  ): Promise<Result<EscrowMilestoneResult, EscrowProviderError>> {
    if (!input.providerMilestoneRef.startsWith(FAKE_MILESTONE_PREFIX)) {
      return {
        success: false,
        error: { type: "PROVIDER_NOT_FOUND", providerRef: input.providerMilestoneRef },
      };
    }
    /**
     * `verification_pending`, never `released`. A provider decides whether evidence is
     * sufficient; we submit it. A fake that accepted its own evidence would model an
     * escrow that is not an escrow.
     */
    return {
      success: true,
      value: {
        providerMilestoneRef: input.providerMilestoneRef,
        state: "verification_pending",
        failureReason: null,
      },
    };
  }

  async requestRelease(
    input: RequestEscrowReleaseInput,
  ): Promise<Result<EscrowMilestoneResult, EscrowProviderError>> {
    if (!input.providerMilestoneRef.startsWith(FAKE_MILESTONE_PREFIX)) {
      return {
        success: false,
        error: { type: "PROVIDER_NOT_FOUND", providerRef: input.providerMilestoneRef },
      };
    }
    if (input.amountInCents <= 0) {
      return {
        success: false,
        error: { type: "PROVIDER_REJECTED", reason: "amount_must_be_positive" },
      };
    }
    return {
      success: true,
      value: {
        providerMilestoneRef: input.providerMilestoneRef,
        state: "release_requested",
        failureReason: null,
      },
    };
  }

  async requestRefund(
    input: RequestEscrowRefundInput,
  ): Promise<Result<EscrowMilestoneResult, EscrowProviderError>> {
    if (!input.providerMilestoneRef.startsWith(FAKE_MILESTONE_PREFIX)) {
      return {
        success: false,
        error: { type: "PROVIDER_NOT_FOUND", providerRef: input.providerMilestoneRef },
      };
    }
    if (input.amountInCents <= 0) {
      return {
        success: false,
        error: { type: "PROVIDER_REJECTED", reason: "amount_must_be_positive" },
      };
    }
    return {
      success: true,
      value: {
        providerMilestoneRef: input.providerMilestoneRef,
        state: "release_requested",
        failureReason: null,
      },
    };
  }

  async retrieveSession(
    providerSessionRef: string,
  ): Promise<Result<EscrowSessionResult, EscrowProviderError>> {
    if (!providerSessionRef.startsWith(FAKE_SESSION_PREFIX)) {
      return {
        success: false,
        error: { type: "PROVIDER_NOT_FOUND", providerRef: providerSessionRef },
      };
    }
    /**
     * The fake holds no state, so the reconciler learns nothing new from it. That is
     * honest: a poll against a stateless fake must not invent a settlement, and
     * `awaiting_funding` is the only answer it can give without lying.
     */
    return {
      success: true,
      value: {
        providerSessionRef,
        state: "awaiting_funding",
        hostedActionUrl: null,
        milestones: [],
      },
    };
  }

  parseWebhook(
    rawBody: Buffer,
    headers: Readonly<Record<string, string | undefined>>,
    signingSecret: string,
  ): Result<ParsedEscrowWebhook, EscrowProviderError> {
    const verification = verifyEscrowWebhookSignature({
      rawBody,
      signatureHeader: headers["x-qatoto-escrow-signature"],
      timestampHeader: headers["x-qatoto-escrow-timestamp"],
      signingSecret,
    });
    if (!verification.success) return verification;

    // Decode only after the signature holds. Parsing an unverified body would run the
    // schema against bytes from an unauthenticated source for no benefit.
    return decodeEscrowWebhookBody(rawBody);
  }
}

interface EscrowSignatureInput {
  readonly rawBody: Buffer;
  readonly signatureHeader: string | undefined;
  readonly timestampHeader: string | undefined;
  readonly signingSecret: string;
}

/**
 * Adapts the shared verifier's tagged errors into this adapter's own error union.
 *
 * The comparison itself lives in `src/lib/webhook-signature.ts` so that five connectors
 * cannot end up with five subtly different implementations of the one check that decides
 * whether an unauthenticated request is believed.
 */
export function verifyEscrowWebhookSignature(
  input: EscrowSignatureInput,
): Result<true, EscrowProviderError> {
  const verified = verifyWebhookSignature({
    rawBody: input.rawBody,
    signatureHeader: input.signatureHeader,
    timestampHeader: input.timestampHeader,
    signingSecret: input.signingSecret,
  });
  if (verified.success) return { success: true, value: true };

  switch (verified.error.type) {
    case "SIGNATURE_HEADERS_MISSING":
      return {
        success: false,
        error: { type: "SIGNATURE_INVALID", reason: "missing_signature_headers" },
      };
    case "TIMESTAMP_MALFORMED":
      return {
        success: false,
        error: { type: "SIGNATURE_INVALID", reason: "malformed_timestamp" },
      };
    case "TIMESTAMP_OUTSIDE_TOLERANCE":
      return {
        success: false,
        error: { type: "SIGNATURE_INVALID", reason: "timestamp_outside_tolerance" },
      };
    case "SIGNATURE_MISMATCH":
      return {
        success: false,
        error: { type: "SIGNATURE_INVALID", reason: "signature_mismatch" },
      };
    default: {
      const exhaustiveError: never = verified.error;
      throw new Error(`Unhandled webhook signature error: ${JSON.stringify(exhaustiveError)}`);
    }
  }
}

/**
 * A WEBHOOK BODY IS THE MOST HOSTILE INPUT THIS BACKEND TAKES. It arrives on a route with
 * no session, from a host we do not control, and it is the only thing permitted to move a
 * memo balance. So it is PARSED rather than narrowed by hand, against the same schema that
 * defines the event union itself.
 *
 * The fake's wire shape is already the normalized shape, so this reads as a parse. A real
 * adapter translates its provider's dialect into the same union here, which is exactly
 * where that translation belongs — nothing downstream should know a provider's vocabulary.
 */
function decodeEscrowWebhookBody(
  rawBody: Buffer,
): Result<ParsedEscrowWebhook, EscrowProviderError> {
  let candidateBody: unknown;
  try {
    candidateBody = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return { success: false, error: { type: "PROVIDER_REJECTED", reason: "malformed_json_body" } };
  }

  const parsed = EscrowWebhookEnvelopeSchema.safeParse(candidateBody);
  if (!parsed.success) {
    /**
     * The reason is a stable tag, not the Zod message. A provider's payload can contain
     * commercial detail, and this string reaches logs and a 4xx body.
     */
    return {
      success: false,
      error: { type: "PROVIDER_REJECTED", reason: "webhook_schema_invalid" },
    };
  }

  return {
    success: true,
    value: {
      providerEventId: parsed.data.providerEventId,
      eventType: parsed.data.eventType,
      event: parsed.data.event,
    },
  };
}

/** Ours, minted before the call, so a retried command is recognisably the same command. */
export function mintEscrowIdempotencyKey(
  purpose: "session" | "lock" | "verification" | "release" | "refund",
): string {
  return `escrow_${purpose}_${randomUUID()}`;
}

/**
 * Resolves the adapter for one provider row.
 *
 * FAIL-CLOSED IN PRODUCTION for the fake, exactly as the payment adapter is: shipping a
 * stateless fake as if it were a licensed escrow holder would imply custody and
 * protection that do not exist, which is the precise claim §14 forbids.
 */
export function resolveExternalEscrowProvider(
  providerSlug: string,
): Result<ExternalEscrowProviderAdapter, EscrowProviderError> {
  const parsedName = parseExternalEscrowProviderName(providerSlug);
  if (!parsedName.success) return parsedName;

  switch (parsedName.value) {
    case "fake": {
      if (config.NODE_ENV === "production") {
        return {
          success: false,
          error: {
            type: "PROVIDER_UNAVAILABLE",
            reason:
              'The "fake" escrow provider is refuse-closed in production; no funds are held by it and no protection exists. Configure a licensed provider before offering escrow.',
          },
        };
      }
      return { success: true, value: new FakeExternalEscrowProviderAdapter() };
    }
    case "escrow_com":
    case "shieldpay": {
      return {
        success: false,
        error: {
          type: "PROVIDER_UNAVAILABLE",
          reason: `Escrow provider "${parsedName.value}" is registered but its adapter is not implemented yet.`,
        },
      };
    }
    default: {
      const exhaustiveProvider: never = parsedName.value;
      throw new Error(`Unhandled escrow provider: ${JSON.stringify(exhaustiveProvider)}`);
    }
  }
}
