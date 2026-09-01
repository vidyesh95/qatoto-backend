import express from "express";

import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody, longFormBody } from "#src/middleware/json-body.js";
import {
  supportCaseMessageLimiter,
  supportCaseOpenLimiter,
  supportModerationLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";
import * as supportCasesController from "#src/modules/platform/support/support-cases.controller.js";

/**
 * Support cases — a person's own conversation with staff, and the queue that answers it.
 *
 * ## MOUNTED AT `/support`, A PREFIX THAT COLLIDES WITH NOTHING
 *
 * `/cases` and `/admin` are distinct literal first segments and `:caseId` only ever appears
 * one segment inside `/cases`, so no literal is shadowed by a parameter and there is no
 * `*.routes.order.test.ts` to write. That is by construction of the naming, not luck.
 *
 * ## NO CAPABILITY MIDDLEWARE ON THE ADMIN ROUTES
 *
 * `handle_support_cases` is checked INSIDE the service, before any id is read — the reasoning
 * `user-reports.routes.ts` records: a route-level guard makes the capability probeable, an
 * id-first service makes the route an existence oracle, and middleware cannot return a
 * `Result` so it could not take part in the controller's exhaustive error switch.
 *
 * ## `requireIdentifiedUser` ON THE TWO WRITES A MEMBER MAKES
 *
 * The `anonymous()` plugin makes a session nearly free, so a per-user limiter alone bounds
 * nothing. The guard prices the identity and the limiter bounds what one identity does with
 * it — the pairing `problemReportLimiter` and `platformFeedbackLimiter` both document.
 *
 * ⚠️ It is NOT on the staff routes, deliberately: a staff account already proved far more
 * than identity by holding a platform role, and adding the guard there would refuse a
 * passkey-only admin for no gain.
 *
 * ## EVERY WRITE REQUIRES AN IDEMPOTENCY KEY, INCLUDING THE OPEN
 *
 * The report routes can leave it optional because a partial unique index gives a replay an
 * honest 409 to answer with. NOTHING here is unique — two cases about two problems are two
 * cases, by design — so on this surface the middleware is the ONLY thing standing between a
 * retried submit on a train and a duplicate case in the queue. The decision route requires it
 * for the stronger reason the report queues do: it appends a hash-chained audit entry, and a
 * retry that appended a second one would make the chain claim two decisions were taken.
 */
const router = express.Router();

/**
 * `longFormBody` ON THE OPEN, `compactBody` ON EVERYTHING ELSE, and the split was found by
 * `json-body-budget.test.ts` rather than guessed: this body carries a 4,000-character
 * description alongside a 200-character subject and a 100-character reference, and at the
 * astral-plane worst case of four bytes per character that is ~17.4 KB — past the 16 KB
 * compact cap. A route that 413s a body its own schema accepts is the failure that suite
 * exists to catch. The three routes below each carry ONE bounded field and fit.
 */
router.post(
  "/cases",
  requireAuth,
  requireIdentifiedUser,
  supportCaseOpenLimiter,
  longFormBody,
  idempotency({ required: true, scope: "user" }),
  supportCasesController.openSupportCase,
);

router.get("/cases", requireAuth, supportCasesController.listOwnSupportCases);

router.get("/cases/:caseId", requireAuth, supportCasesController.getOwnSupportCase);

router.post(
  "/cases/:caseId/messages",
  requireAuth,
  requireIdentifiedUser,
  supportCaseMessageLimiter,
  compactBody,
  idempotency({ required: true, scope: "user" }),
  supportCasesController.addOwnSupportCaseMessage,
);

router.get(
  "/admin/cases",
  requireAuth,
  supportModerationLimiter,
  supportCasesController.listSupportCaseQueue,
);

router.get(
  "/admin/cases/:caseId",
  requireAuth,
  supportModerationLimiter,
  supportCasesController.getSupportCaseForStaff,
);

router.post(
  "/admin/cases/:caseId/messages",
  requireAuth,
  supportModerationLimiter,
  compactBody,
  idempotency({ required: true, scope: "user" }),
  supportCasesController.addStaffSupportCaseMessage,
);

router.post(
  "/admin/cases/:caseId/decisions",
  requireAuth,
  supportModerationLimiter,
  compactBody,
  idempotency({ required: true, scope: "user" }),
  supportCasesController.decideSupportCase,
);

export default router;
