import type { Request, Response } from "express";

import {
  firstParam,
  optionalBody,
  respondProjectError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/rnd/projects/project-error-response.js";
import * as insightLinksService from "#src/modules/rnd/projects/project-insight-links.service.js";
import * as membershipService from "#src/modules/rnd/projects/project-membership.service.js";
import {
  CreateProjectSchema,
  InsightIdParamSchema,
  LinkMarketInsightSchema,
  ListMyProjectsQuerySchema,
  ListProjectsQuerySchema,
  UpdateMemberSchema,
  UpdateProjectSchema,
  UpdateProjectStageSchema,
} from "#src/modules/rnd/projects/research-projects.schemas.js";
import * as projectsService from "#src/modules/rnd/projects/research-projects.service.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

/** POST /research-projects */
export async function createProject(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = CreateProjectSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  // The founder id comes from the SESSION. There is no founderUserId field in the
  // schema above, so there is nothing for a client to forge (§0).
  const createResult = await projectsService.createResearchProject(req.user.id, parsedBody.data);
  if (!createResult.success) {
    respondProjectError(res, createResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 201,
    message: "Project created successfully",
    data: createResult.value,
  };
  res.status(201).json(response);
}

/** GET /research-projects — the public feed. `active` only. */
export async function listProjects(req: Request, res: Response): Promise<void> {
  const parsedQuery = ListProjectsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const { category, stage, page, limit } = parsedQuery.data;
  const projectsPage = await projectsService.listPublicProjects({
    categorySlug: category,
    stage,
    page,
    limit,
  });

  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message: "Projects retrieved successfully",
    data: [...projectsPage.rows],
    pagination: {
      page,
      limit,
      total: projectsPage.total,
      totalPages: Math.ceil(projectsPage.total / limit),
    },
  };
  res.status(200).json(response);
}

/** GET /research-projects/slugs — for generateStaticParams. No cookie required. */
export async function listProjectSlugs(_req: Request, res: Response): Promise<void> {
  const slugs = await projectsService.listPublicProjectSlugs();

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Project slugs retrieved successfully",
    data: slugs,
  };
  res.status(200).json(response);
}

/** GET /research-projects/mine — filtered by the SESSION id; no userId param exists. */
export async function listMyProjects(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedQuery = ListMyProjectsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const { status, page, limit } = parsedQuery.data;
  const projectsPage = await projectsService.listMyProjects(req.user.id, { status, page, limit });

  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message: "Projects retrieved successfully",
    data: [...projectsPage.rows],
    pagination: {
      page,
      limit,
      total: projectsPage.total,
      totalPages: Math.ceil(projectsPage.total / limit),
    },
  };
  res.status(200).json(response);
}

/** GET /research-projects/:projectSlug — drafts are member-only, else 404. */
export async function getProject(req: Request, res: Response): Promise<void> {
  const projectSlug = firstParam(req.params.projectSlug ?? "");
  const findResult = await projectsService.findResearchProjectBySlug(
    projectSlug,
    req.user?.id ?? null,
  );

  if (!findResult.success) {
    respondProjectError(res, findResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Project retrieved successfully",
    data: findResult.value,
  };
  res.status(200).json(response);
}

/**
 * Resolves the caller's standing on a project, or writes the 404 and returns null.
 *
 * Every project-scoped handler starts with this. The failure is written here so the
 * status policy lives in exactly one place.
 */
async function requireRoleOrRespond(
  req: Request,
  res: Response,
  minimumRole: membershipService.ProjectMemberRole,
): Promise<membershipService.ProjectMemberContext | null> {
  if (!req.user) {
    respondUnauthenticated(res);
    return null;
  }

  const projectSlug = firstParam(req.params.projectSlug ?? "");
  const accessResult = await membershipService.requireProjectRole(
    projectSlug,
    req.user.id,
    minimumRole,
  );

  if (!accessResult.success) {
    respondProjectError(res, accessResult.error);
    return null;
  }
  return accessResult.value;
}

/** PATCH /research-projects/:projectSlug */
export async function updateProject(req: Request, res: Response): Promise<void> {
  const parsedBody = UpdateProjectSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  // The equity band is the founder's OWN advertised offer (§13), so widening it is a
  // founder-only act; everything else on this route is maintainer+.
  const touchesEquityBand =
    parsedBody.data.offeredEquityBasisPointsMin !== undefined ||
    parsedBody.data.offeredEquityBasisPointsMax !== undefined;

  const context = await requireRoleOrRespond(
    req,
    res,
    touchesEquityBand ? "founder" : "maintainer",
  );
  if (!context) {
    return;
  }

  const updateResult = await projectsService.updateResearchProject(
    context.projectId,
    parsedBody.data,
  );
  if (!updateResult.success) {
    respondProjectError(res, updateResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Project updated successfully",
    data: updateResult.value,
  };
  res.status(200).json(response);
}

/** POST /research-projects/:projectSlug/cover — multipart, field `cover`. */
export async function uploadCover(req: Request, res: Response): Promise<void> {
  const context = await requireRoleOrRespond(req, res, "maintainer");
  if (!context) {
    return;
  }

  if (!req.file) {
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "A cover image file is required.",
      errors: { cover: ["No file was uploaded."] },
    });
    return;
  }

  const uploadResult = await projectsService.setProjectCover(context.projectId, req.file.buffer);
  if (!uploadResult.success) {
    respondProjectError(res, uploadResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Cover image updated successfully",
    data: uploadResult.value,
  };
  res.status(200).json(response);
}

/** DELETE /research-projects/:projectSlug/cover */
export async function deleteCover(req: Request, res: Response): Promise<void> {
  const context = await requireRoleOrRespond(req, res, "maintainer");
  if (!context) {
    return;
  }

  const deleteResult = await projectsService.removeProjectCover(context.projectId);
  if (!deleteResult.success) {
    respondProjectError(res, deleteResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Cover image removed successfully",
    data: deleteResult.value,
  };
  res.status(200).json(response);
}

/** POST /research-projects/:projectSlug/publish — the server-side completeness gate. */
export async function publishProject(req: Request, res: Response): Promise<void> {
  const context = await requireRoleOrRespond(req, res, "founder");
  if (!context || !req.user) {
    return;
  }

  const publishResult = await projectsService.publishResearchProject(
    context.projectId,
    req.user.id,
  );
  if (!publishResult.success) {
    respondProjectError(res, publishResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Project published successfully",
    data: publishResult.value,
  };
  res.status(200).json(response);
}

/** POST /research-projects/:projectSlug/unpublish */
export async function unpublishProject(req: Request, res: Response): Promise<void> {
  const context = await requireRoleOrRespond(req, res, "founder");
  if (!context || !req.user) {
    return;
  }

  const unpublishResult = await projectsService.unpublishResearchProject(
    context.projectId,
    req.user.id,
  );
  if (!unpublishResult.success) {
    respondProjectError(res, unpublishResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Project unpublished successfully",
    data: unpublishResult.value,
  };
  res.status(200).json(response);
}

/** POST /research-projects/:projectSlug/archive — terminal; there is no un-archive. */
export async function archiveProject(req: Request, res: Response): Promise<void> {
  const context = await requireRoleOrRespond(req, res, "founder");
  if (!context || !req.user) {
    return;
  }

  const archiveResult = await projectsService.archiveResearchProject(
    context.projectId,
    req.user.id,
  );
  if (!archiveResult.success) {
    respondProjectError(res, archiveResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Project archived successfully",
    data: archiveResult.value,
  };
  res.status(200).json(response);
}

/** PATCH /research-projects/:projectSlug/stage — writes an append-only audit row. */
export async function changeStage(req: Request, res: Response): Promise<void> {
  const parsedBody = UpdateProjectStageSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const context = await requireRoleOrRespond(req, res, "founder");
  if (!context || !req.user) {
    return;
  }

  const stageResult = await projectsService.changeProjectStage(
    context.projectId,
    req.user.id,
    parsedBody.data.stage,
    parsedBody.data.note ?? null,
  );
  if (!stageResult.success) {
    respondProjectError(res, stageResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Project stage updated successfully",
    data: stageResult.value,
  };
  res.status(200).json(response);
}

/** GET /research-projects/:projectSlug/team — name and avatar JOIN from `user`. */
export async function getTeam(req: Request, res: Response): Promise<void> {
  const projectSlug = firstParam(req.params.projectSlug ?? "");
  const findResult = await projectsService.findResearchProjectBySlug(
    projectSlug,
    req.user?.id ?? null,
  );

  if (!findResult.success) {
    respondProjectError(res, findResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Team retrieved successfully",
    data: findResult.value.team,
  };
  res.status(200).json(response);
}

/** GET /research-projects/:projectSlug/stage-history */
export async function getStageHistory(req: Request, res: Response): Promise<void> {
  const context = await requireRoleOrRespond(req, res, "contributor");
  if (!context) {
    return;
  }

  const transitions = await projectsService.listProjectStageTransitions(context.projectId);

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Stage history retrieved successfully",
    data: transitions,
  };
  res.status(200).json(response);
}

/** PATCH /research-projects/:projectSlug/members/:memberId — founder only. */
export async function updateMember(req: Request, res: Response): Promise<void> {
  const parsedBody = UpdateMemberSchema.safeParse(optionalBody(req));
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const context = await requireRoleOrRespond(req, res, "founder");
  if (!context) {
    return;
  }

  const memberId = firstParam(req.params.memberId ?? "");
  const updateResult = await membershipService.updateProjectMember(
    context.projectId,
    memberId,
    parsedBody.data,
  );
  if (!updateResult.success) {
    respondProjectError(res, updateResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Member updated successfully",
    data: updateResult.value,
  };
  res.status(200).json(response);
}

/** DELETE /research-projects/:projectSlug/members/me — sets `left`, never deletes. */
export async function leaveProject(req: Request, res: Response): Promise<void> {
  const context = await requireRoleOrRespond(req, res, "contributor");
  if (!context || !req.user) {
    return;
  }

  const leaveResult = await membershipService.leaveProject(context.projectId, req.user.id);
  if (!leaveResult.success) {
    respondProjectError(res, leaveResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "You have left the project",
    data: leaveResult.value,
  };
  res.status(200).json(response);
}

/** DELETE /research-projects/:projectSlug/members/:memberId — founder only. */
export async function removeMember(req: Request, res: Response): Promise<void> {
  const context = await requireRoleOrRespond(req, res, "founder");
  if (!context || !req.user) {
    return;
  }

  const memberId = firstParam(req.params.memberId ?? "");
  const removeResult = await membershipService.removeProjectMember(
    context.projectId,
    memberId,
    req.user.id,
  );
  if (!removeResult.success) {
    respondProjectError(res, removeResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Member removed successfully",
    data: removeResult.value,
  };
  res.status(200).json(response);
}

/** POST /research-projects/:projectSlug/watch — idempotent. */
export async function watchProject(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const projectSlug = firstParam(req.params.projectSlug ?? "");
  const project = await membershipService.findProjectBySlug(projectSlug);

  // Only a published project can be watched — a draft is not public, and revealing
  // that its slug exists would defeat the draft visibility rule.
  if (!project || project.projectStatus !== "active") {
    respondProjectError(res, { type: "NOT_FOUND", projectRef: projectSlug });
    return;
  }

  await projectsService.watchProject(project.projectId, req.user.id);

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Project watched",
    data: { isWatchedByViewer: true },
  };
  res.status(200).json(response);
}

/** DELETE /research-projects/:projectSlug/watch — idempotent. */
export async function unwatchProject(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const projectSlug = firstParam(req.params.projectSlug ?? "");
  const project = await membershipService.findProjectBySlug(projectSlug);

  if (!project) {
    respondProjectError(res, { type: "NOT_FOUND", projectRef: projectSlug });
    return;
  }

  await projectsService.unwatchProject(project.projectId, req.user.id);

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Project unwatched",
    data: { isWatchedByViewer: false },
  };
  res.status(200).json(response);
}

/**
 * POST /research-projects/:projectSlug/market-insight-links — founder or moderator (§11k.2).
 *
 * NO `requireRoleOrRespond` HERE, and that is the one place this route departs from every
 * other write in this file. That helper resolves MEMBERSHIP; this route's second accepted
 * caller is platform staff who is not a member at all, so the dual decision lives in the
 * service where both arms collapse into a single 404.
 */
export async function linkMarketInsight(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = LinkMarketInsightSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const linked = await insightLinksService.linkMarketInsightToProject(
    req.user.id,
    firstParam(req.params.projectSlug ?? ""),
    parsedBody.data.insightId,
  );

  if (!linked.success) {
    respondProjectError(res, linked.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 201,
    message: "Market insight cited",
    data: linked.value,
  };
  res.status(201).json(response);
}

/** DELETE /research-projects/:projectSlug/market-insight-links/:insightId (§11k.2). */
export async function unlinkMarketInsight(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedParams = InsightIdParamSchema.safeParse({
    insightId: firstParam(req.params.insightId ?? ""),
  });
  if (!parsedParams.success) {
    respondValidationFailed(res, parsedParams.error);
    return;
  }

  const unlinked = await insightLinksService.unlinkMarketInsightFromProject(
    req.user.id,
    firstParam(req.params.projectSlug ?? ""),
    parsedParams.data.insightId,
  );

  if (!unlinked.success) {
    respondProjectError(res, unlinked.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Citation removed",
    data: unlinked.value,
  };
  res.status(200).json(response);
}
