import express from "express";

import * as suppliersController from "#src/controllers/suppliers.controller.js";
import { attachOptionalUser } from "#src/middleware/attach-optional-user.js";
import { parseCompactJsonBody } from "#src/middleware/json-body.js";
import { supplierWriteLimiter } from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";

/**
 * Go-to-market — the supplier / ODM directory and launch readiness
 * (R_AND_D_BACKEND_STRUCTURE.md §11i, Appendix B4).
 *
 * TWO ROUTERS, because the domain genuinely has two halves:
 *
 *   `supplierRouter` mounts at `/` — a supplier belongs to no project, and someone arriving
 *   from the `/go-to-market` stage card has not picked one. Same reasoning as
 *   `researchCatalogRouter` and `fundingRouter`.
 *
 *   `projectGoToMarketRouter` mounts at `/research-projects` — a SIXTH router on that
 *   prefix, after projects, workshop, proof-of-effort, funding and compensation. Still no
 *   collision: every one of them matches `/:projectSlug` as exactly one segment and none
 *   swallows a deeper path.
 *
 * CHAIN ORDER, everywhere: auth → limiter → requireIdentifiedUser → parser → controller.
 * The limiter precedes `requireIdentifiedUser` so an unidentified caller cannot hammer that
 * guard's extra query, and both follow `requireAuth` because the limiter keys on
 * `req.user.id`.
 *
 * NO ROLE MIDDLEWARE ON THE WRITES, and that is the §4a Layer 3 rule rather than an
 * omission: `requirePlatformCapability` runs IN-SERVICE, before any id or slug is read, so
 * these routes are not id oracles and the refusal can participate in the controller's
 * exhaustive error switch. A middleware cannot return a `Result`.
 *
 * WHY `requireIdentifiedUser` IS ON THE WRITES AT ALL, given they are already
 * moderator-gated: `src/lib/auth.ts` registers the `anonymous()` plugin, so a session
 * proves nothing about identity on its own. Defence in depth costs one query on a path
 * that runs a handful of times a day.
 *
 * ROUTE ORDER: literal segments before `/:param`. `/supplier-capabilities` and
 * `/launch-ready-projects` are distinct top-level paths and cannot be swallowed by
 * `/suppliers/:supplierSlug`, but the rule is stated so nobody later adds a sibling under
 * `/suppliers/` that can be.
 *
 * READS ARE PUBLIC (`attachOptionalUser`), unlike `/discovery/talent`. A supplier row is a
 * business listing, not a person — the §6 read-auth rule turns on personal data, and there
 * is none here.
 */

export const supplierRouter = express.Router();

// --- The capability vocabulary. Seeded; there is no POST, so no spam surface and hence no
//     moderation state — `discovery_skill`'s reasoning verbatim.
supplierRouter.get(
  "/supplier-capabilities",
  attachOptionalUser,
  suppliersController.listSupplierCapabilities,
);

// --- The launch-ready rail. Reads `product.researchProjectId`, the one column R&D
//     contributes to the store. The CTA from here points at `/studio/products`; there is
//     deliberately no listing-create endpoint on this router.
supplierRouter.get(
  "/launch-ready-projects",
  attachOptionalUser,
  suppliersController.listLaunchReadyProjects,
);

// --- The directory.
supplierRouter.get("/suppliers", attachOptionalUser, suppliersController.listSuppliers);
supplierRouter.get("/suppliers/:supplierSlug", attachOptionalUser, suppliersController.getSupplier);

/**
 * `POST /suppliers` — platform `moderator` only.
 *
 * `verificationState` is in no schema, so a new listing is always `unverified`. Only the
 * PATCH below moves it, and only a moderator can reach that either.
 */
supplierRouter.post(
  "/suppliers",
  requireAuth,
  supplierWriteLimiter,
  requireIdentifiedUser,
  parseCompactJsonBody,
  suppliersController.createSupplier,
);

/** `PATCH /suppliers/:supplierId` — platform `moderator` only. The slug is unwritable. */
supplierRouter.patch(
  "/suppliers/:supplierId",
  requireAuth,
  supplierWriteLimiter,
  requireIdentifiedUser,
  parseCompactJsonBody,
  suppliersController.updateSupplier,
);

/**
 * The project-scoped half: one derived read, behind membership.
 *
 * The checklist exposes `project_stats` and the bake state — a project's private operating
 * numbers — so membership is proven from the slug and failure is 404, never 403.
 */
export const projectGoToMarketRouter = express.Router();

projectGoToMarketRouter.get(
  "/:projectSlug/launch-readiness",
  requireAuth,
  suppliersController.getLaunchReadiness,
);

export default supplierRouter;
