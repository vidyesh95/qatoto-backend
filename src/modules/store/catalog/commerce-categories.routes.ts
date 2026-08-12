import express from "express";

import { compactBody } from "#src/middleware/json-body.js";
import {
  commerceCategoryImageUploadLimiter,
  commerceCategoryRequestLimiter,
  commerceCategoryWriteLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";
import * as commerceCategoriesController from "#src/modules/store/catalog/commerce-categories.controller.js";
import { uploadCommerceCategoryImage } from "#src/modules/store/catalog/upload-commerce-category-image.js";

const router = express.Router();

/**
 * The store's browse taxonomy — admin writes and seller requests.
 *
 * THE PUBLIC READS ARE NOT HERE. `GET /store/categories` and `GET /store/categories/:slug`
 * are already served by `store.routes.ts`, where the detail route also returns facets and a
 * page of products. This router carries only what did not exist: the admin write surface and
 * the request queue behind it.
 *
 * ROUTE ORDER IS LOAD-BEARING. Express matches in declaration order, so the literal
 * `/admin/categories/reorder` MUST come before `/admin/categories/:categoryId` — otherwise
 * "reorder" is captured as a category id and every reorder 404s.
 *
 * CHAIN ORDER, as everywhere here: auth → limiter → parser/upload → controller.
 *
 * THERE IS NO CAPABILITY MIDDLEWARE IN ANY CHAIN, and that is not an omission. The
 * `moderate_commerce` check happens inside the service so it can return a `Result` and take
 * part in the controller's exhaustive error switch (see platform-role.service.ts), and so it
 * can be proven to run BEFORE any id is read.
 *
 * THE SELLER ROUTES ARE THE ONLY NON-STAFF WRITES, and they touch a different table. A
 * request mints nothing; only a moderator's verdict creates a category. `requireIdentifiedUser`
 * is what keeps the moderation queue attributable — a request nobody can be traced to is a
 * request nobody can act on.
 */

/** POST /commerce/category-requests — a seller asks for a category that does not exist. */
router.post(
  "/category-requests",
  requireAuth,
  commerceCategoryRequestLimiter,
  requireIdentifiedUser,
  compactBody,
  commerceCategoriesController.submitCategoryRequest,
);

/**
 * GET /commerce/category-requests/mine — LITERAL, and the only read on this pair.
 * Declared before the admin routes purely for adjacency with its POST; there is no
 * `/:param` sibling under `/category-requests` for it to shadow.
 */
router.get(
  "/category-requests/mine",
  requireAuth,
  commerceCategoryWriteLimiter,
  commerceCategoriesController.listOwnCategoryRequests,
);

/** GET /commerce/admin/categories — the whole tree, draft and retired included. */
router.get(
  "/admin/categories",
  requireAuth,
  commerceCategoryWriteLimiter,
  commerceCategoriesController.listCategoriesForStaff,
);

/**
 * POST /commerce/admin/categories (multipart/form-data, optional field `image`) — create.
 * Carries only the upload limiter; stacking two double-counts every request against the
 * stricter of them.
 */
router.post(
  "/admin/categories",
  requireAuth,
  commerceCategoryImageUploadLimiter,
  uploadCommerceCategoryImage,
  commerceCategoriesController.createCategory,
);

/** PATCH /commerce/admin/categories/reorder — LITERAL, must precede /:categoryId. */
router.patch(
  "/admin/categories/reorder",
  requireAuth,
  commerceCategoryWriteLimiter,
  compactBody,
  commerceCategoriesController.reorderCategories,
);

/** PATCH /commerce/admin/categories/:categoryId — name, parent, synonyms, state. */
router.patch(
  "/admin/categories/:categoryId",
  requireAuth,
  commerceCategoryWriteLimiter,
  compactBody,
  commerceCategoriesController.updateCategory,
);

/** PATCH /commerce/admin/categories/:categoryId/image (multipart) — replace in place. */
router.patch(
  "/admin/categories/:categoryId/image",
  requireAuth,
  commerceCategoryImageUploadLimiter,
  uploadCommerceCategoryImage,
  commerceCategoriesController.replaceCategoryImage,
);

/**
 * POST /commerce/admin/categories/:categoryId/retire — out of browse, reversibly.
 * There is deliberately no DELETE: `product.categoryId` is ON DELETE RESTRICT and the
 * demand snapshots cascade, so removal would either fail or take history with it.
 */
router.post(
  "/admin/categories/:categoryId/retire",
  requireAuth,
  commerceCategoryWriteLimiter,
  commerceCategoriesController.retireCategory,
);

/** GET /commerce/admin/category-requests — the moderation queue. */
router.get(
  "/admin/category-requests",
  requireAuth,
  commerceCategoryWriteLimiter,
  commerceCategoriesController.listCategoryRequestsForStaff,
);

/** POST /commerce/admin/category-requests/:requestId/decide — terminal verdict. */
router.post(
  "/admin/category-requests/:requestId/decide",
  requireAuth,
  commerceCategoryWriteLimiter,
  compactBody,
  commerceCategoriesController.decideCategoryRequest,
);

export default router;
