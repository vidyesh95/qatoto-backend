import type { Request, Response } from "express";

import { config } from "#src/config/index.js";
import { logger } from "#src/lib/logger.js";
import {
  loadProviderById,
  resolveWebhookSigningSecret,
} from "#src/modules/store/fulfillment/commerce-connector.service.js";
import { applyNormalizedEscrowEvent } from "#src/modules/store/orders/commerce-escrow.service.js";
import { confirmRazorpayOrderFromWebhook } from "#src/modules/store/orders/commerce-payments.service.js";
import {
  EmptyObjectSchema,
  ProviderIdParamsSchema,
  RazorpayWebhookBodySchema,
} from "#src/modules/store/storefront/commerce-webhooks.schemas.js";
import { resolveExternalEscrowProvider } from "#src/modules/store/storefront/external-escrow-provider.adapter.js";
import { verifyRazorpayWebhookSignature } from "#src/modules/store/storefront/razorpay-payment-provider.adapter.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * Answers 202, not 200, and deliberately.
 *
 * The event has been persisted and applied inside one transaction, so "accepted" is honest;
 * but nothing downstream of it — a release command, a fulfillment freeze — has necessarily
 * finished. §7 reserves 202 for exactly that, and a provider reading 200 as "fully
 * processed" would be reading more than this route promises.
 */
function sendAccepted(res: Response, deduplicated: boolean): void {
  res.status(202).json({
    status: "success",
    statusCode: 202,
    message: deduplicated ? "Event already recorded." : "Event accepted.",
  } satisfies ApiResponse);
}

function sendRejected(res: Response, statusCode: 400 | 401 | 404 | 503): void {
  res.status(statusCode).json({
    status: "error",
    statusCode,
    message: "Webhook rejected.",
  } satisfies ApiResponse);
}

export async function receiveEscrowWebhook(req: Request, res: Response): Promise<void> {
  const parsedParams = ProviderIdParamsSchema.safeParse(req.params);
  const parsedQuery = EmptyObjectSchema.safeParse(req.query);
  if (!parsedParams.success || !parsedQuery.success) {
    sendRejected(res, 400);
    return;
  }

  /**
   * The raw-body mount produces a Buffer. Anything else means the mount order in `app.ts`
   * has been changed and the JSON parser reached this route first — in which case the
   * signature could never verify, and the honest answer is to fail rather than to attempt
   * a re-serialization that would silently accept unsigned bodies.
   */
  if (!Buffer.isBuffer(req.body)) {
    logger.error("escrow webhook received a parsed body; the raw-body mount is misconfigured", {
      providerId: parsedParams.data.providerId,
      bodyType: typeof req.body,
    });
    sendRejected(res, 400);
    return;
  }
  const rawBody: Buffer = req.body;

  const providerLoaded = await loadProviderById(parsedParams.data.providerId);
  if (!providerLoaded.success) {
    // 404 for an unknown or inactive provider, with no detail: an unauthenticated caller
    // does not get to learn which provider ids are configured and active.
    sendRejected(res, 404);
    return;
  }
  if (providerLoaded.value.connectorKind !== "external_escrow") {
    sendRejected(res, 404);
    return;
  }

  const secretResolved = resolveWebhookSigningSecret(providerLoaded.value);
  if (!secretResolved.success) {
    /**
     * A provider that is active but has no usable secret is OUR misconfiguration, and it
     * is logged loudly. The caller still gets a bare 401: telling it that the secret is
     * missing tells it that signature checking is currently impossible.
     */
    logger.error("escrow webhook signing secret is unavailable", {
      providerId: providerLoaded.value.id,
      providerSlug: providerLoaded.value.providerSlug,
      reason: secretResolved.error.type,
    });
    sendRejected(res, 401);
    return;
  }

  const adapterResolved = resolveExternalEscrowProvider(providerLoaded.value.providerSlug);
  if (!adapterResolved.success) {
    logger.error("escrow webhook arrived for a provider with no adapter", {
      providerId: providerLoaded.value.id,
      providerSlug: providerLoaded.value.providerSlug,
    });
    sendRejected(res, 404);
    return;
  }

  const headers: Record<string, string | undefined> = {};
  for (const [headerName, headerValue] of Object.entries(req.headers)) {
    headers[headerName] = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  }

  const parsedWebhook = adapterResolved.value.parseWebhook(rawBody, headers, secretResolved.value);
  if (!parsedWebhook.success) {
    const isSignatureFailure = parsedWebhook.error.type === "SIGNATURE_INVALID";
    logger.warn("escrow webhook rejected", {
      providerId: providerLoaded.value.id,
      errorType: parsedWebhook.error.type,
    });
    sendRejected(res, isSignatureFailure ? 401 : 400);
    return;
  }

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    // Unreachable: the adapter already parsed it to produce the event. Kept so the inbox
    // never stores a payload string it did not verify was JSON.
    sendRejected(res, 400);
    return;
  }

  const applied = await applyNormalizedEscrowEvent({
    providerId: providerLoaded.value.id,
    providerEventId: parsedWebhook.value.providerEventId,
    eventType: parsedWebhook.value.eventType,
    event: parsedWebhook.value.event,
    rawPayload,
  });

  if (!applied.success) {
    /**
     * The event was persisted and marked with its error before we got here, so it is
     * durable and inspectable. The provider is told we accepted the DELIVERY, because
     * making it retry an event we have recorded and cannot apply achieves nothing except
     * a retry storm — and telling it *why* would leak whether the session exists.
     */
    logger.warn("escrow webhook stored but not applied", {
      providerId: providerLoaded.value.id,
      providerEventId: parsedWebhook.value.providerEventId,
      errorType: applied.error.type,
    });
    sendAccepted(res, false);
    return;
  }

  sendAccepted(res, applied.value.deduplicated);
}

/**
 * POST /webhooks/payments/razorpay (Store Phase 5, test mode).
 *
 * THE BODY IS A HINT, NOT A FACT. After the signature verifies, the only thing read from it
 * is the order id; `confirmRazorpayOrderFromWebhook` re-fetches the order from Razorpay and
 * settles only what Razorpay reports. That is also the replay defence: Razorpay signs no
 * timestamp, but replaying `order.paid` cannot settle an order Razorpay does not call paid,
 * and a genuine replay finds the settlement event already recorded and posts nothing.
 *
 * 503 when unconfigured or when Razorpay cannot be reached, so Razorpay redelivers; 202 for
 * everything we accepted, including events for orders this backend never created.
 */
export async function receiveRazorpayPaymentWebhook(req: Request, res: Response): Promise<void> {
  const parsedQuery = EmptyObjectSchema.safeParse(req.query);
  if (!parsedQuery.success) {
    sendRejected(res, 400);
    return;
  }

  const razorpayWebhookSecret = config.RAZORPAY_WEBHOOK_SECRET;
  if (razorpayWebhookSecret === undefined) {
    logger.error("razorpay webhook arrived but RAZORPAY_WEBHOOK_SECRET is not configured");
    sendRejected(res, 503);
    return;
  }

  if (!Buffer.isBuffer(req.body)) {
    logger.error("razorpay webhook received a parsed body; the raw-body mount is misconfigured", {
      bodyType: typeof req.body,
    });
    sendRejected(res, 400);
    return;
  }
  const rawBody: Buffer = req.body;

  const signatureVerified = verifyRazorpayWebhookSignature({
    rawBody,
    signatureHeader: req.header("x-razorpay-signature"),
    webhookSecret: razorpayWebhookSecret,
  });
  if (!signatureVerified.success) {
    logger.warn("razorpay webhook rejected", { errorType: signatureVerified.error.type });
    sendRejected(res, 401);
    return;
  }

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    sendRejected(res, 400);
    return;
  }
  const parsedBody = RazorpayWebhookBodySchema.safeParse(rawPayload);
  if (!parsedBody.success) {
    sendRejected(res, 400);
    return;
  }

  const razorpayOrderId =
    parsedBody.data.payload.order?.entity.id ?? parsedBody.data.payload.payment?.entity.order_id;
  if (!razorpayOrderId) {
    // A payment with no order (e.g. a payment link) is not something this backend created.
    sendAccepted(res, false);
    return;
  }

  const confirmed = await confirmRazorpayOrderFromWebhook(razorpayOrderId, new Date());
  if (!confirmed.success) {
    logger.warn("razorpay webhook accepted but not applied", {
      razorpayEvent: parsedBody.data.event,
      razorpayOrderId,
      errorType: confirmed.error.type,
    });
    // Razorpay unreachable: ask for redelivery. Anything else is ours and a retry storm would
    // not fix it — accept the delivery; reconcile retries the confirm on its own schedule.
    if (confirmed.error.type === "PROVIDER_UNAVAILABLE") {
      sendRejected(res, 503);
      return;
    }
    sendAccepted(res, false);
    return;
  }

  sendAccepted(res, false);
}
