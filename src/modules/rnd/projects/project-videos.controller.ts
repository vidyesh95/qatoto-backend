import type { Request, Response } from "express";

import { respondValidationFailed } from "#src/modules/rnd/projects/project-error-response.js";
import { resolveRoleVisibleProjectOrRespond } from "#src/modules/rnd/projects/project-roles.controller.js";
import { ListProjectVideosQuerySchema } from "#src/modules/rnd/projects/research-projects.schemas.js";
import * as projectVideosService from "#src/modules/studio/videos/project-videos.service.js";
import type { PaginatedResponse } from "#src/types/index.js";

/**
 * `GET /research-projects/:projectSlug/videos` — the venture's own film reel (§11i).
 *
 * PUBLIC (`attachOptionalUser`) for a published project, member-only for a draft, through the
 * SAME gate the roles routes use. A laxer gate here would let anyone confirm a draft slug
 * exists by asking for its videos, which is precisely what that shared helper prevents.
 *
 * The service lives in the STUDIO module because `video` is a studio table; this controller
 * lives in R&D because the route is project-scoped and the authorization is a project fact.
 */
export async function listProjectVideos(req: Request, res: Response): Promise<void> {
  const project = await resolveRoleVisibleProjectOrRespond(req, res);
  if (!project) return;

  const parsedQuery = ListProjectVideosQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const { page, limit } = parsedQuery.data;
  const videosPage = await projectVideosService.listProjectVideos(project.projectId, {
    page,
    limit,
  });

  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message: "Videos retrieved successfully",
    data: [...videosPage.rows],
    pagination: {
      page,
      limit,
      total: videosPage.total,
      totalPages: Math.ceil(videosPage.total / limit),
    },
  };
  res.status(200).json(response);
}
