import express from "express";

import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody, longFormBody } from "#src/middleware/json-body.js";
import {
  productCatalogDepthWriteLimiter,
  productCreateLimiter,
  productImageUploadLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import * as productsController from "#src/modules/store/catalog/products.controller.js";
import { uploadProductHighlightImageFile } from "#src/modules/store/catalog/upload-product-highlight-image.js";
import { uploadProductImage } from "#src/modules/store/catalog/upload-product-image.js";
import { requireActiveSellerCommerceOrganization } from "#src/modules/store/organizations/require-active-commerce-organization.js";

const router = express.Router();

router.use(requireAuth, requireActiveSellerCommerceOrganization);

/**
 * Every /products route requires a session; the seller id is always req.user.id,
 * and every /:id operation re-verifies ownership in the service (→ 404 when the
 * caller doesn't own the row, never leaking which ids exist) — STORE §0.
 *
 * ROUTE ORDER: the literal `/mine` is declared BEFORE `/:id` so "mine" is never
 * swallowed as an id param (same rule as the users router's `/me`).
 */

/**
 * POST /products
 * Create a draft listing. Rate-limited per seller.
 */
router.post(
  "/",
  productCreateLimiter,
  longFormBody,
  idempotency({ scope: "active_organization" }),
  productsController.createProduct,
);

/**
 * GET /products/mine
 * The caller's own listings (paginated). Declared before `/:id`.
 */
router.get("/mine", productsController.getMyProducts);

/**
 * GET /products/:id
 * Full listing (images + tiers) for the edit/detail flow. Owner only.
 */
router.get("/:id", productsController.getProductById);

/**
 * PATCH /products/:id
 * Partial update of mutable fields (+ optional tier replacement).
 */
router.patch(
  "/:id",
  longFormBody,
  idempotency({ scope: "active_organization" }),
  productsController.updateProduct,
);

/**
 * DELETE /products/:id
 * Delete the listing (cascades images + tiers; destroys Cloudinary assets first).
 */
router.delete(
  "/:id",
  compactBody,
  idempotency({ scope: "active_organization" }),
  productsController.deleteProduct,
);

/**
 * PUT /products/:id/variants
 * Replace the variant set (Appendix A1). Declared before `/:id/images/...` for the
 * same reason `/mine` precedes `/:id` — a literal segment must never be read as an id.
 */
router.put(
  "/:id/variants",
  productCatalogDepthWriteLimiter,
  longFormBody,
  idempotency({ scope: "active_organization" }),
  productsController.replaceVariants,
);

/**
 * PUT /products/:id/highlights
 * Replace the highlight cards (Appendix A6).
 */
/**
 * A18. Same chain as variants and highlights. The per-slot minimum order quantity a
 * seller declares here is a commercial term the cart and checkout enforce.
 */
router.put(
  "/:id/customization-options",
  productCatalogDepthWriteLimiter,
  longFormBody,
  idempotency({ scope: "active_organization" }),
  productsController.replaceCustomizationOptions,
);

router.put(
  "/:id/highlights",
  productCatalogDepthWriteLimiter,
  longFormBody,
  idempotency({ scope: "active_organization" }),
  productsController.replaceHighlights,
);

/**
 * POST /products/:id/highlights/:highlightId/image  (multipart/form-data, field `image`)
 *
 * Migration `0091`. The highlight plan above is authored first; this attaches the bytes.
 * No `longFormBody` — multer owns this body, as on the gallery upload below. Uses the
 * image upload limiter rather than the catalog-depth one because this is the expensive
 * path.
 */
router.post(
  "/:id/highlights/:highlightId/image",
  productImageUploadLimiter,
  uploadProductHighlightImageFile,
  idempotency({ scope: "active_organization" }),
  productsController.replaceHighlightImage,
);

/**
 * POST /products/:id/images  (multipart/form-data, field `image`)
 * Attach one image. Buffered + size-capped by uploadProductImage, then the
 * service re-validates the bytes. Rate-limited per seller (expensive path).
 */
router.post(
  "/:id/images",
  productImageUploadLimiter,
  uploadProductImage,
  idempotency({ scope: "active_organization" }),
  productsController.uploadImage,
);

/**
 * PATCH /products/:id/images/reorder
 * Set the gallery order (index 0 = main image). Declared before the parameterized
 * `/:id/images/:imageId` so "reorder" is never read as an image id.
 */
router.patch(
  "/:id/images/reorder",
  longFormBody,
  idempotency({ scope: "active_organization" }),
  productsController.reorderImages,
);

/**
 * DELETE /products/:id/images/:imageId
 * Remove one image and re-pack remaining positions.
 */
router.delete(
  "/:id/images/:imageId",
  compactBody,
  idempotency({ scope: "active_organization" }),
  productsController.deleteImage,
);

/**
 * POST /products/:id/publish
 * draft → active (server-side completeness gate).
 */
router.post(
  "/:id/publish",
  compactBody,
  idempotency({ scope: "active_organization" }),
  productsController.publishProduct,
);

/**
 * POST /products/:id/unpublish
 * active → draft.
 */
router.post(
  "/:id/unpublish",
  compactBody,
  idempotency({ scope: "active_organization" }),
  productsController.unpublishProduct,
);

export default router;
