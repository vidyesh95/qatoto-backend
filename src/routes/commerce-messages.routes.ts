import express from "express";

import * as commerceMessagesController from "#src/controllers/commerce-messages.controller.js";
import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody, longFormBody } from "#src/middleware/json-body.js";
import { commerceMessageWriteLimiter } from "#src/middleware/rate-limit.js";
import { requireActiveCommerceOrganization } from "#src/middleware/require-active-commerce-organization.js";
import { requireAuth } from "#src/middleware/require-auth.js";

const commerceMessagesRouter = express.Router();

commerceMessagesRouter.post(
  "/threads",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceMessageWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceMessagesController.createOrGetThread,
);

commerceMessagesRouter.get(
  "/threads/:threadId/messages",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceMessagesController.listMessages,
);

commerceMessagesRouter.post(
  "/threads/:threadId/messages",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceMessageWriteLimiter,
  longFormBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceMessagesController.appendMessage,
);

export default commerceMessagesRouter;
