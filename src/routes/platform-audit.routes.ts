import express from "express";

import * as platformAuditController from "#src/controllers/platform-audit.controller.js";
import { chainVerifyLimiter } from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";

const router = express.Router();

/**
 * The platform moderation log (R_AND_D_BACKEND_STRUCTURE.md §11l.2 item 2).
 *
 * ROOT-MOUNTED at `/admin/audit-trail`, not under `/discovery/admin`: the log spans
 * taxonomy, the supplier directory, content review and role grants, and filing it under
 * one of those would make the other three look like they were not covered.
 *
 * ROUTE ORDER: `/verify` is a LITERAL and is declared FIRST. There is no
 * `/admin/audit-trail/:entryId` today, and if one is added it goes below that line — or
 * `/verify` resolves as "the entry whose id is verify" and returns a plausible 404.
 *
 * `chainVerifyLimiter` on the verifier and not on the list, matching §9's audit trail: a
 * verification walks every entry and hashes each one, and it is the one read here whose
 * cost grows with the log rather than with the page.
 *
 * NO WRITE ROUTES, ever. Entries are appended by the services that make the decisions,
 * inside the same transaction; an endpoint that could add one would let a moderator write
 * their own history (§4f).
 */

router.get(
  "/admin/audit-trail/verify",
  requireAuth,
  chainVerifyLimiter,
  platformAuditController.verifyPlatformAuditChain,
);

router.get("/admin/audit-trail", requireAuth, platformAuditController.listPlatformAuditTrail);

export default router;
