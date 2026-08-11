import type { Request, Response } from "express";
import { z } from "zod";

import { resolveExternalEscrowProvider } from "#src/adapters/external-escrow-provider.adapter.js";
import { logger } from "#src/lib/logger.js";
import {
  loadProviderById,
  resolveWebhookSigningSecret,
} from "#src/services/commerce-connector.service.js";
import { applyNormalizedEscrowEvent } from "#src/services/commerce-escrow.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * Inbound connector webhooks (STORE Phase 14).
 *
 * THIS IS THE FIRST ROUTE IN THIS BACKEND WITH NO SESSION. Nothing about the caller is
 * known until its signature verifies, so four rules govern it and none is optional:
 *
 *   1. THE BODY IS RAW BYTES. `app.ts` mounts `express.raw` on `/webhooks/*` ahead of the
 *      JSON parser, because the digest must be computed over exactly what arrived.
 *      `JSON.stringify(req.body)` reorders keys and drops whitespace, so a body that
 *      round-tripped through the JSON parser can never match the sender's signature.
 *   2. THE SIGNATURE IS THE AUTHENTICATION. It is verified before the payload is even
 *      parsed, let alone acted on.
 *   3. A REPLAY IS A NO-OP THAT STILL ANSWERS 200. Deduplication happens against the
 *      inbox's unique `(provider_id, provider_event_id)` index. Answering 4xx to a
 *      duplicate would make a well-behaved provider retry something already done.
 *   4. FAILURES ARE OPAQUE. The provider learns whether we accepted the delivery and
 *      nothing else — not whether the session exists, not which organizations are party to
 *      it. An unauthenticated caller must not be able to probe this backend for order ids.
 */

const ProviderIdParamsSchema = z.object({ providerId: z.string().trim().min(1).max(200) }).strict();

const EmptyObjectSchema = z.object({}).strict();

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

function sendRejected(res: Response, statusCode: 400 | 401 | 404): void {
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
