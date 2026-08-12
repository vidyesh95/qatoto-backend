import express from "express";

import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody, longFormBody } from "#src/middleware/json-body.js";
import { commerceMessageWriteLimiter } from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
/**
 * §14, consequence for A14. Every route here runs on a possibly-`pending` workspace.
 *
 * §14 named four places the trust gate stays and messaging is not among them; its own A14
 * note says `ask_question` stops being the common case for a signed-in visitor "because a
 * signed-in visitor now has an organization". A buyer who cannot message a seller until
 * staff review them is the wall this phase exists to remove.
 *
 * SCOPING IS UNCHANGED: `assertThreadParticipant` still proves membership of the specific
 * thread, so a pending workspace can reach its OWN conversations and no others.
 */
import { requireProvisionedBuyerCommerceWorkspace } from "#src/modules/store/organizations/require-active-commerce-organization.js";
import * as commerceMessagesController from "#src/modules/store/procurement/commerce-messages.controller.js";

const commerceMessagesRouter = express.Router();

commerceMessagesRouter.post(
  "/threads",
  requireAuth,
  requireProvisionedBuyerCommerceWorkspace,
  commerceMessageWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceMessagesController.createOrGetThread,
);

/**
 * A38. DECLARED BEFORE `/threads/:threadId/messages` is unnecessary — different depth — but
 * declared before the POST on the same path for readability: the read is what makes the write
 * reachable on a second visit.
 *
 * No rate limiter, matching the messages read beside it: a list changes nothing and has no body.
 */
commerceMessagesRouter.get(
  "/threads",
  requireAuth,
  requireProvisionedBuyerCommerceWorkspace,
  commerceMessagesController.listThreads,
);

commerceMessagesRouter.get(
  "/threads/:threadId/messages",
  requireAuth,
  requireProvisionedBuyerCommerceWorkspace,
  commerceMessagesController.listMessages,
);

commerceMessagesRouter.post(
  "/threads/:threadId/messages",
  requireAuth,
  requireProvisionedBuyerCommerceWorkspace,
  commerceMessageWriteLimiter,
  longFormBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceMessagesController.appendMessage,
);

export default commerceMessagesRouter;
