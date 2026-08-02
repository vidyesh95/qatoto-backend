/**
 * The home feed's public read surface (HOME_BACKEND_STRUCTURE.md §5.1).
 *
 * Today this is one route. `GET /feed/videos` — the ranked page that Recommended, Explore
 * and Spotlight are all slices of — lands here in phase 3, which is why the file exists
 * with a single handler rather than being folded into a neighbour and moved later.
 */

import type { Request, Response } from "express";

import * as contentCategoriesService from "#src/services/content-categories.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * `GET /feed/categories` — PUBLIC. Every active category, already ordered.
 *
 * NO QUERY SCHEMA AND NO `safeParse`, and that is not a gap in the boundary. There is no
 * filter to offer: the response is the whole active taxonomy, and `?includeInactive` is a
 * staff question that does not belong on the front page's data source. The house rule
 * ".strict() on every query schema" is satisfied vacuously — no schema at all is a
 * different thing from a permissive one, and the handler reads nothing off `req`.
 *
 * `ApiResponse`, not `PaginatedResponse`: a bounded couple-of-dozen-row taxonomy has no
 * pages. `listCategories`, `listRegions` and `listSkills` all make the same call.
 */
export async function listFeedCategories(_req: Request, res: Response): Promise<void> {
  const categories = await contentCategoriesService.listActiveContentCategories();

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Categories retrieved successfully",
    data: categories,
  };
  res.status(200).json(response);
}
