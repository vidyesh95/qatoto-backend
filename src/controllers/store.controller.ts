import type { Request, Response } from "express";
import { z } from "zod";

import { respondValidationFailed } from "#src/modules/rnd/projects/project-error-response.js";
import * as commerceProductRelationsService from "#src/modules/store/catalog/commerce-product-relations.service.js";
import * as storeCatalogService from "#src/modules/store/catalog/store-catalog.service.js";
import type { StoreCatalogError } from "#src/modules/store/catalog/store-catalog.service.js";
import * as storeMerchandisingService from "#src/modules/store/catalog/store-merchandising.service.js";
import * as storeSearchService from "#src/modules/store/catalog/store-search.service.js";
import * as commerceDeliveryEstimateService from "#src/modules/store/fulfillment/commerce-delivery-estimate.service.js";
import * as commerceFreightJourneyService from "#src/modules/store/fulfillment/commerce-freight-journey.service.js";
import { resolveActiveCommerceOrganization } from "#src/modules/store/organizations/commerce-organization-access.service.js";
import * as commerceProvidersService from "#src/modules/store/procurement/commerce-providers.service.js";
import {
  StoreOrganizationReviewParamsSchema,
  StoreProductReviewParamsSchema,
  StoreReviewListQuerySchema,
} from "#src/schemas/store-reviews.schemas.js";
import {
  CategoriesQuerySchema,
  CategoryParamsSchema,
  CursorPageQuerySchema,
  DeliveryEstimateQuerySchema,
  OfferingParamsSchema,
  OrganizationParamsSchema,
  PathwayParamsSchema,
  ProductParamsSchema,
  ProvidersQuerySchema,
  RailParamsSchema,
  SearchQuerySchema,
} from "#src/schemas/store.schemas.js";
import * as storePathwaysService from "#src/services/store-pathways.service.js";
import * as storeReviewsService from "#src/services/store-reviews.service.js";
import type { ApiResponse } from "#src/types/index.js";

function sendZodError(res: Response, error: z.ZodError): void {
  /**
   * Delegates to the ONE shared responder (§0).
   *
   * This used to build its own body, and got two things wrong that only showed up in the browser:
   * it forwarded `fieldErrors` alone, so `.strict()`'s `unrecognized_keys` — the way EVERY rejected
   * server-owned field arrives — vanished into an empty object; and it put the payload under `data`,
   * which the client's envelope reader never looks at. The result was a 422 that said "Validation
   * failed." and named nothing.
   */
  respondValidationFailed(res, error);
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
    limit: parsed.data.limit,
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
    /**
     * A39. THE SLUG, not the id. The facets now read `store_search_document`, which is scoped
     * by `category_slug` exactly as the search filters are — passing the id would mean two
     * subtree walks keyed differently, which is the shape of the divergence this closed.
     */
    storeCatalogService.getCategoryFacets(categoryResult.value.category.slug),
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
  /**
   * A39. ONE FILTER OBJECT, passed to both. `searchStoreDocuments` adds paging to it and
   * `computeStoreSearchFacets` does not — building two would be how the counts and the results
   * start describing different sets again.
   */
  const searchFilters = {
    query: parsed.data.query,
    categorySlug: parsed.data.category,
    sellerCountryCode: parsed.data.sellerCountryCode,
    providerKind: parsed.data.providerKind,
    documentKind: parsed.data.documentKind,
    minOrderQuantityMax: parsed.data.minOrderQuantityMax,
    priceMinInCents: parsed.data.priceMinInCents,
    priceMaxInCents: parsed.data.priceMaxInCents,
    stockState: parsed.data.stockState,
    samplePolicy: parsed.data.samplePolicy,
    condition: parsed.data.condition,
    verificationState: parsed.data.verificationState,
    leadTimeMaxDays: parsed.data.leadTimeMaxDays,
    sort: parsed.data.sort ?? "relevance",
  } as const;

  const [result, facets] = await Promise.all([
    storeSearchService.searchStoreDocuments({
      ...searchFilters,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor,
    }),
    storeSearchService.computeStoreSearchFacets(searchFilters),
  ]);
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
    // A39. Search had thirteen filters and no denominator until Phase 22.
    data: { ...result.value, facets },
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

  const lines = [{ productId: productResult.value.id, quantity: query.data.quantity }];

  /**
   * Phase 20, §19.5. `lanePlan` is EXTENDED ALONGSIDE `estimates`, never in place of it —
   * A16's per-currency whole-journey projection is unchanged, byte for byte, and clients
   * reading only `data.estimates` see exactly what they saw before.
   *
   * The two are independent, so they run together. `estimates` is derived from provider
   * COVERAGE (who serves this lane); `lanePlan` is derived from purchased RATE CARDS (what a
   * lane costs by mode). Neither can answer the other's question.
   */
  const [estimates, originCountryCode] = await Promise.all([
    commerceDeliveryEstimateService.estimateDeliveryForLines({
      sellerOrganizationId: productResult.value.seller.organizationId,
      destinationCountryCode: query.data.destinationCountryCode,
      lines,
    }),
    commerceDeliveryEstimateService.resolveShippingOriginCountryCode(
      productResult.value.seller.organizationId,
    ),
  ]);

  const lanePlan = await commerceFreightJourneyService.planFreightJourney({
    originCountryCode,
    originLocality: null,
    destinationCountryCode: query.data.destinationCountryCode,
    destinationLocality: null,
    lines,
    asOf: new Date(),
  });

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Indicative delivery estimate.",
    // NO DATES IN `lanePlan` — durations only. A product page has no order, so there is no
    // clock to start (§19.4: "no arrival window before an order exists").
    data: { estimates, lanePlan },
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

/**
 * A24. Who is reading, for `viewer.hasVotedHelpful` on each review card.
 *
 * The same descriptive resolution `getProduct` performs above, and for the same reason:
 * the review list is a public page, so a missing organization decides what to render
 * rather than whether to answer. `commerce_review_vote` is keyed on the organization,
 * so a signed-in visitor without one gets `null` — they cannot vote either.
 */
async function resolveReviewViewer(
  req: Request,
): Promise<storeReviewsService.StoreReviewViewerContext> {
  if (!req.user || !req.authSession?.activeOrganizationId) {
    return storeReviewsService.ANONYMOUS_REVIEW_VIEWER;
  }
  const activeOrganization = await resolveActiveCommerceOrganization({
    userId: req.user.id,
    activeOrganizationId: req.authSession.activeOrganizationId,
  });
  return {
    organizationId: activeOrganization.success ? activeOrganization.value.organizationId : null,
  };
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

  const result = await storeReviewsService.listProductReviews(
    params.data.productSlug,
    query.data,
    await resolveReviewViewer(req),
  );
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
    await resolveReviewViewer(req),
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
