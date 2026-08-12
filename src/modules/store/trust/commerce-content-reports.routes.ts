import express from "express";

import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody } from "#src/middleware/json-body.js";
import {
  commerceContentReportLimiter,
  commerceTrustModerationLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";
import * as commerceContentReportsController from "#src/modules/store/trust/commerce-content-reports.controller.js";

/**
 * Content reports and the commerce moderation queue (STORE Appendix A12).
 *
 * NO ORGANIZATION MIDDLEWARE. Reporting is open to any identified user — requiring an
 * active commerce organization would mean only verified sellers and buyers could
 * report anything, which is backwards for an abuse surface. The reporter's
 * organization, when there is one, is read from context and used only to refuse a
 * self-report.
 *
 * The `/admin/*` routes carry NO capability middleware either. `moderate_commerce` is
 * checked INSIDE the service, before any id is read, which is the convention across
 * this codebase: a route-level guard makes the capability probeable and an id-first
 * service makes the route an existence oracle. Both are avoided by doing it in that
 * order.
 */
const commerceContentReportsRouter = express.Router();

commerceContentReportsRouter.post(
  "/reports",
  requireAuth,
  requireIdentifiedUser,
  commerceContentReportLimiter,
  compactBody,
  // User-scoped: a reporter may have no organization, and the organization scope 400s
  // when `req.commerceOrganization` is absent.
  idempotency({ scope: "user" }),
  commerceContentReportsController.createContentReport,
);

commerceContentReportsRouter.get(
  "/admin/content-reports",
  requireAuth,
  commerceTrustModerationLimiter,
  commerceContentReportsController.listContentReports,
);

commerceContentReportsRouter.post(
  "/admin/content-reports/:reportId/decisions",
  requireAuth,
  commerceTrustModerationLimiter,
  compactBody,
  idempotency({ required: true, scope: "user" }),
  commerceContentReportsController.decideContentReport,
);

/**
 * Restoring is its own route rather than a dismissal, because content can be hidden
 * with no open report left to dismiss: the threshold hides it, the reports are then
 * actioned, and a later reconsideration has nothing to act on. Without this the
 * content is stuck hidden.
 */
commerceContentReportsRouter.post(
  "/admin/content/restore",
  requireAuth,
  commerceTrustModerationLimiter,
  compactBody,
  idempotency({ required: true, scope: "user" }),
  commerceContentReportsController.restoreContent,
);

commerceContentReportsRouter.get(
  "/admin/moderation-actions",
  requireAuth,
  commerceTrustModerationLimiter,
  commerceContentReportsController.listModerationActions,
);

export default commerceContentReportsRouter;
