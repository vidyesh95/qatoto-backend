import type { Request, Response } from "express";
import { z } from "zod";

import {
  StoreOrganizationReviewParamsSchema,
  StoreProductReviewParamsSchema,
  StoreReviewListQuerySchema,
} from "#src/schemas/store-reviews.schemas.js";
import * as commerceDeliveryEstimateService from "#src/services/commerce-delivery-estimate.service.js";
import { resolveActiveCommerceOrganization } from "#src/services/commerce-organization-access.service.js";
import * as commerceProductRelationsService from "#src/services/commerce-product-relations.service.js";
import * as commerceProvidersService from "#src/services/commerce-providers.service.js";
import * as storeCatalogService from "#src/services/store-catalog.service.js";
import type { StoreCatalogError } from "#src/services/store-catalog.service.js";
import * as storeMerchandisingService from "#src/services/store-merchandising.service.js";
import * as storePathwaysService from "#src/services/store-pathways.service.js";
import * as storeReviewsService from "#src/services/store-reviews.service.js";
import * as storeSearchService from "#src/services/store-search.service.js";
import type { ApiResponse } from "#src/types/index.js";

const CursorPageQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(48).default(24),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const CategoriesQuerySchema = z
  .object({
    parentCategoryId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const CategoryParamsSchema = z.object({ slug: z.string().trim().min(1).max(100) }).strict();
const ProductParamsSchema = z.object({ productSlug: z.string().trim().min(1).max(120) }).strict();
const OrganizationParamsSchema = z
  .object({ organizationSlug: z.string().trim().min(1).max(100) })
  .strict();
const PathwayParamsSchema = z.object({ pathwaySlug: z.string().trim().min(1).max(100) }).strict();
const RailParamsSchema = z.object({ railSlug: z.string().trim().min(1).max(100) }).strict();
const OfferingParamsSchema = z.object({ offeringSlug: z.string().trim().min(1).max(120) }).strict();

const SearchQuerySchema = z
  .object({
    query: z.string().trim().max(200).optional(),
    category: z.string().trim().min(1).max(100).optional(),
    sellerCountryCode: z
      .string()
      .trim()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    providerKind: z
      .enum([
        "freight_forwarder",
        "logistics_operator",
        "customs_broker",
        "insurance_provider",
        "inspection_agency",
        "testing_certification_lab",
        "marketing_agency",
        "warehouse_provider",
        "foreign_exchange_facilitator",
      ])
      .optional(),
    documentKind: z.enum(["product", "provider_offering"]).optional(),
    minOrderQuantityMax: z.coerce.number().int().min(0).max(1_000_000).optional(),
    sort: z.enum(["relevance"]).optional(),
    limit: z.coerce.number().int().min(1).max(48).default(24),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const ProvidersQuerySchema = z
  .object({
    providerKind: z
      .enum([
        "freight_forwarder",
        "logistics_operator",
        "customs_broker",
        "insurance_provider",
        "inspection_agency",
        "testing_certification_lab",
        "marketing_agency",
        "warehouse_provider",
        "foreign_exchange_facilitator",
      ])
      .optional(),
    limit: z.coerce.number().int().min(1).max(48).default(24),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

function sendZodError(res: Response, error: z.ZodError): void {
  res.status(422).json({
    status: "error",
    statusCode: 422,
    message: "Validation failed.",
    errors: z.flattenError(error).fieldErrors,
  });
}

export async function getHome(_req: Request, res: Response): Promise<void> {
  const result = await storeMerchandisingService.getStoreHome();
  if (!result.success) {
    switch (result.error.type) {
      case "PROVIDER_DIRECTORY_FAILED":
        res.status(503).json({
          status: "error",
          statusCode: 503,
          message: "Store home provider directory is temporarily unavailable.",
        } satisfies ApiResponse);
        return;
      case "NOT_FOUND":
      case "INVALID_CURSOR":
        res.status(500).json({
          status: "error",
          statusCode: 500,
          message: "Store home failed unexpectedly.",
        } satisfies ApiResponse);
        return;
      default: {
        const exhaustiveError: never = result.error;
        void exhaustiveError;
        throw new Error("Unhandled store home error.");
      }
    }
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Store home.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function listCategories(req: Request, res: Response): Promise<void> {
  const parsed = CategoriesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendZodError(res, parsed.error);
    return;
  }
  const result = await storeCatalogService.listActiveCategories({
    parentCategoryId: parsed.data.parentCategoryId ?? null,
  });
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Categories.",
    data: result,
  } satisfies ApiResponse);
}

export async function getCategory(req: Request, res: Response): Promise<void> {
  const params = CategoryParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const page = CursorPageQuerySchema.safeParse(req.query);
  if (!page.success) {
    sendZodError(res, page.error);
    return;
  }

  const categoryResult = await storeCatalogService.getCategoryBySlug(params.data.slug);
  if (!categoryResult.success) {
    res.status(404).json({
      status: "error",
      statusCode: 404,
      message: "Category not found.",
    } satisfies ApiResponse);
    return;
  }

  const [productsResult, facets] = await Promise.all([
    storeCatalogService.listEligibleProducts({
      categoryId: categoryResult.value.category.id,
      limit: page.data.limit,
      cursor: page.data.cursor,
    }),
    storeCatalogService.getCategoryFacets(categoryResult.value.category.id),
  ]);
  if (!productsResult.success) {
    switch (productsResult.error.type) {
      case "INVALID_CURSOR":
        res.status(422).json({
          status: "error",
          statusCode: 422,
          message: "Invalid cursor.",
        } satisfies ApiResponse);
        return;
      case "NOT_FOUND":
        res.status(404).json({
          status: "error",
          statusCode: 404,
          message: "Not found.",
        } satisfies ApiResponse);
        return;
      default: {
        const exhaustiveError: never = productsResult.error;
        void exhaustiveError;
        throw new Error("Unhandled store catalog error.");
      }
    }
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Category.",
    data: {
      ...categoryResult.value,
      facets,
      products: productsResult.value,
    },
  } satisfies ApiResponse);
}

export async function search(req: Request, res: Response): Promise<void> {
  const parsed = SearchQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendZodError(res, parsed.error);
    return;
  }
  const result = await storeSearchService.searchStoreDocuments({
    query: parsed.data.query,
    categorySlug: parsed.data.category,
    sellerCountryCode: parsed.data.sellerCountryCode,
    providerKind: parsed.data.providerKind,
    documentKind: parsed.data.documentKind,
    minOrderQuantityMax: parsed.data.minOrderQuantityMax,
    sort: parsed.data.sort ?? "relevance",
    limit: parsed.data.limit,
    cursor: parsed.data.cursor,
  });
  if (!result.success) {
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "Invalid cursor.",
    } satisfies ApiResponse);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Search results.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function getProduct(req: Request, res: Response): Promise<void> {
  const params = ProductParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  /**
   * A11 / A14. `attachOptionalUser` may or may not have resolved a session, and the
   * store router carries no organization middleware — a public page must render for a
   * visitor with no account at all.
   *
   * The organization is resolved HERE rather than by a guard, because on this route it
   * is descriptive, not required: it decides whether `contactAffordance` is `chat` or
   * `ask_question`, and whether `engagement.viewer` is state or `null`. A guard would
   * turn a rendering detail into a 403.
   */
  const activeOrganization =
    req.user && req.authSession?.activeOrganizationId
      ? await resolveActiveCommerceOrganization({
          userId: req.user.id,
          activeOrganizationId: req.authSession.activeOrganizationId,
        })
      : null;

  const result = await storeCatalogService.getPublicProductBySlug(params.data.productSlug, {
    userId: req.user?.id ?? null,
    organizationId: activeOrganization?.success ? activeOrganization.value.organizationId : null,
    memberRole: activeOrganization?.success ? activeOrganization.value.memberRole : null,
  });
  if (!result.success) {
    res.status(404).json({
      status: "error",
      statusCode: 404,
      message: "Product not found.",
    } satisfies ApiResponse);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Product.",
    data: result.value,
  } satisfies ApiResponse);
}

/**
 * GET /store/products/:productSlug/companions (§15.7).
 *
 * Grouped by `relationKind`, each companion carrying `sourceKind` so a client can
 * never render a seller's compatibility claim as a verified one (§15.3).
 */
const DeliveryEstimateQuerySchema = z
  .object({
    destinationCountryCode: z
      .string()
      .trim()
      .regex(/^[A-Z]{2}$/, "Use an ISO 3166-1 alpha-2 country code."),
    quantity: z.coerce.number().int().min(1).max(1_000_000).default(1),
  })
  .strict();

/**
 * GET /store/products/:productSlug/delivery-estimate (A16).
 *
 * The destination is an explicit query parameter rather than anything server-derived,
 * because §0 makes a browse-country preference display-only — and an estimate IS
 * display. Nothing gated by this value is a compliance, tax or availability decision.
 *
 * An empty `estimates` array means no provider on the directory covers that route. It
 * does not mean free: the mock this replaces rendered "Free Delivery" over a hardcoded
 * date range, which is exactly the claim §14 blocks.
 */
export async function getProductDeliveryEstimate(req: Request, res: Response): Promise<void> {
  const params = ProductParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const query = DeliveryEstimateQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }

  const productResult = await storeCatalogService.getPublicProductBySlug(params.data.productSlug);
  if (!productResult.success) {
    res.status(404).json({
      status: "error",
      statusCode: 404,
      message: "Product not found.",
    } satisfies ApiResponse);
    return;
  }

  const estimates = await commerceDeliveryEstimateService.estimateDeliveryForLines({
    sellerOrganizationId: productResult.value.seller.organizationId,
    destinationCountryCode: query.data.destinationCountryCode,
    lines: [{ productId: productResult.value.id, quantity: query.data.quantity }],
  });

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Indicative delivery estimate.",
    data: { estimates },
  } satisfies ApiResponse);
}

export async function getProductCompanions(req: Request, res: Response): Promise<void> {
  const params = ProductParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const result = await commerceProductRelationsService.listProductCompanions(
    params.data.productSlug,
  );
  if (!result.success) {
    res.status(404).json({
      status: "error",
      statusCode: 404,
      message: "Product not found.",
    } satisfies ApiResponse);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Product companions.",
    data: { groups: result.value },
  } satisfies ApiResponse);
}

export async function getOrganizationStorefront(req: Request, res: Response): Promise<void> {
  const params = OrganizationParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const page = CursorPageQuerySchema.safeParse(req.query);
  if (!page.success) {
    sendZodError(res, page.error);
    return;
  }
  const result = await storeCatalogService.getPublicOrganizationStorefront({
    organizationSlug: params.data.organizationSlug,
    limit: page.data.limit,
    cursor: page.data.cursor,
  });
  if (!result.success) {
    switch (result.error.type) {
      case "INVALID_CURSOR":
        res.status(422).json({
          status: "error",
          statusCode: 422,
          message: "Invalid cursor.",
        } satisfies ApiResponse);
        return;
      case "NOT_FOUND":
        res.status(404).json({
          status: "error",
          statusCode: 404,
          message: "Organization not found.",
        } satisfies ApiResponse);
        return;
      default: {
        const exhaustiveError: never = result.error;
        void exhaustiveError;
        throw new Error("Unhandled storefront error.");
      }
    }
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Storefront.",
    data: result.value,
  } satisfies ApiResponse);
}

/**
 * Both pathway reads map their errors exhaustively (§7). Before Phase 9 this handler
 * collapsed every failure to 404, which would have rendered a tampered cursor as
 * "Pathway not found" — a wrong answer to a different question.
 */
function mapPathwayError(res: Response, error: storePathwaysService.StorePathwayError): void {
  switch (error.type) {
    case "NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "Pathway not found.",
      } satisfies ApiResponse);
      return;
    case "INVALID_CURSOR":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "Invalid cursor.",
      } satisfies ApiResponse);
      return;
    default: {
      const exhaustiveError: never = error;
      throw new Error(`Unhandled pathway error: ${JSON.stringify(exhaustiveError)}`);
    }
  }
}

export async function listPathways(req: Request, res: Response): Promise<void> {
  const page = CursorPageQuerySchema.safeParse(req.query);
  if (!page.success) {
    sendZodError(res, page.error);
    return;
  }

  const result = await storePathwaysService.listActivePathways({
    limit: page.data.limit,
    cursor: page.data.cursor,
  });
  if (!result.success) {
    mapPathwayError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Pathways.",
    data: result.value,
  } satisfies ApiResponse);
}

/**
 * The set read (§15.7). `slots` replaces the Phase 1 flat `items` array: a slot the
 * set cannot fill is still returned, marked `unavailable`, because an absent slot and
 * a slot with nothing in it are different facts and only the second one is true.
 */
export async function getPathway(req: Request, res: Response): Promise<void> {
  const params = PathwayParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const page = CursorPageQuerySchema.safeParse(req.query);
  if (!page.success) {
    sendZodError(res, page.error);
    return;
  }

  const result = await storePathwaysService.getPathwaySetBySlug({
    pathwaySlug: params.data.pathwaySlug,
    limit: page.data.limit,
    cursor: page.data.cursor,
  });
  if (!result.success) {
    mapPathwayError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Pathway.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function getRail(req: Request, res: Response): Promise<void> {
  const params = RailParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const page = CursorPageQuerySchema.safeParse(req.query);
  if (!page.success) {
    sendZodError(res, page.error);
    return;
  }
  const result = await storeMerchandisingService.getRailBySlug({
    railSlug: params.data.railSlug,
    limit: page.data.limit,
    cursor: page.data.cursor,
  });
  if (!result.success) {
    switch (result.error.type) {
      case "INVALID_CURSOR":
        res.status(422).json({
          status: "error",
          statusCode: 422,
          message: "Invalid cursor.",
        } satisfies ApiResponse);
        return;
      case "NOT_FOUND":
        res.status(404).json({
          status: "error",
          statusCode: 404,
          message: "Rail not found.",
        } satisfies ApiResponse);
        return;
      case "PROVIDER_DIRECTORY_FAILED":
        res.status(503).json({
          status: "error",
          statusCode: 503,
          message: "Store provider directory is temporarily unavailable.",
        } satisfies ApiResponse);
        return;
      default: {
        const exhaustiveError: never = result.error;
        void exhaustiveError;
        throw new Error("Unhandled rail error.");
      }
    }
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Rail.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function listProviders(req: Request, res: Response): Promise<void> {
  const parsed = ProvidersQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendZodError(res, parsed.error);
    return;
  }
  const result = await commerceProvidersService.listPublicProviders({
    providerKind: parsed.data.providerKind,
    limit: parsed.data.limit,
    cursor: parsed.data.cursor,
  });
  if (!result.success) {
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "Invalid cursor.",
    } satisfies ApiResponse);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Providers.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function getProvider(req: Request, res: Response): Promise<void> {
  const params = OrganizationParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const result = await commerceProvidersService.getPublicProviderByOrganizationSlug(
    params.data.organizationSlug,
  );
  if (!result.success) {
    res.status(404).json({
      status: "error",
      statusCode: 404,
      message: "Provider not found.",
    } satisfies ApiResponse);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Provider.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function getServiceOffering(req: Request, res: Response): Promise<void> {
  const params = OfferingParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const result = await commerceProvidersService.getPublicServiceOfferingBySlug(
    params.data.offeringSlug,
  );
  if (!result.success) {
    res.status(404).json({
      status: "error",
      statusCode: 404,
      message: "Service offering not found.",
    } satisfies ApiResponse);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Service offering.",
    data: result.value,
  } satisfies ApiResponse);
}

// ---------------------------------------------------------------------------
// Appendix A8 — public review reads.
//
// Both handlers map `StoreCatalogError` unchanged: that union is already exactly
// {NOT_FOUND, INVALID_CURSOR}, which is the whole failure surface of a public list.
// ---------------------------------------------------------------------------

function mapStoreReviewError(res: Response, error: StoreCatalogError, missingLabel: string): void {
  switch (error.type) {
    case "INVALID_CURSOR":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "Invalid cursor.",
      } satisfies ApiResponse);
      return;
    case "NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: missingLabel,
      } satisfies ApiResponse);
      return;
    default: {
      const exhaustiveError: never = error;
      void exhaustiveError;
      throw new Error("Unhandled store review error.");
    }
  }
}

export async function listProductReviews(req: Request, res: Response): Promise<void> {
  const params = StoreProductReviewParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const query = StoreReviewListQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }

  const result = await storeReviewsService.listProductReviews(params.data.productSlug, query.data);
  if (!result.success) {
    mapStoreReviewError(res, result.error, "Product not found.");
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Product reviews.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function listOrganizationReviews(req: Request, res: Response): Promise<void> {
  const params = StoreOrganizationReviewParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const query = StoreReviewListQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }

  const result = await storeReviewsService.listOrganizationReviews(
    params.data.organizationSlug,
    query.data,
  );
  if (!result.success) {
    mapStoreReviewError(res, result.error, "Organization not found.");
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Organization reviews.",
    data: result.value,
  } satisfies ApiResponse);
}
