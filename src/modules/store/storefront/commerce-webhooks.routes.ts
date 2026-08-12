import express from "express";

import { commerceConnectorWebhookLimiter } from "#src/middleware/rate-limit.js";
import * as commerceWebhooksController from "#src/modules/store/storefront/commerce-webhooks.controller.js";

/**
 * Inbound connector webhooks (STORE Phase 14).
 *
 * NO `requireAuth`, NO `requireActiveCommerceOrganization`, AND NO `compactBody`, all
 * deliberately:
 *
 *   - There is no session. The HMAC signature over the raw body is the authentication,
 *     and it is checked inside the provider's adapter where the scheme lives.
 *   - There is no organization context. A provider does not act on behalf of one, and
 *     which order an event touches is derived from the provider's own session reference,
 *     never from anything the caller asserts.
 *   - The body must stay RAW BYTES. `app.ts` mounts `express.raw` for this path ahead of
 *     the JSON parser; a parsed-and-re-serialized body cannot match the sender's digest.
 *
 * The limiter is IP-keyed and generous — a blast-radius cap, not an access control. It has
 * to admit a genuine burst of redeliveries after a provider outage, and forged bodies are
 * already cheap to reject because verification fails before the database is touched.
 */
const router = express.Router();

router.post(
  "/escrow/:providerId",
  commerceConnectorWebhookLimiter,
  commerceWebhooksController.receiveEscrowWebhook,
);

export default router;
