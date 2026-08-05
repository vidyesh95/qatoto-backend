import type { Request, Response } from "express";
import { z } from "zod";

import * as commerceProvidersService from "#src/services/commerce-providers.service.js";
import * as storeCatalogService from "#src/services/store-catalog.service.js";
import * as storeMerchandisingService from "#src/services/store-merchandising.service.js";
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
  const result = await storeCatalogService.getPublicProductBySlug(params.data.productSlug);
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

export async function listPathways(_req: Request, res: Response): Promise<void> {
  const result = await storeMerchandisingService.listPathways();
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Pathways.",
    data: result,
  } satisfies ApiResponse);
}

export async function getPathway(req: Request, res: Response): Promise<void> {
  const params = PathwayParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const result = await storeMerchandisingService.getPathwayBySlug(params.data.pathwaySlug);
  if (!result.success) {
    res.status(404).json({
      status: "error",
      statusCode: 404,
      message: "Pathway not found.",
    } satisfies ApiResponse);
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
