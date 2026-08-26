import type { Request, Response } from "express";

import {
  firstParam,
  respondProjectError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/rnd/projects/project-error-response.js";
import * as membershipService from "#src/modules/rnd/projects/project-membership.service.js";
import {
  CreateOpenRoleSchema,
  ListOpenRolesQuerySchema,
  UpdateOpenRoleSchema,
} from "#src/modules/rnd/projects/project-roles.schemas.js";
import * as rolesService from "#src/modules/rnd/projects/project-roles.service.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

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

/**
 * The read-side visibility gate, shared by the list and the detail read.
 *
 * A draft's roles are visible only to its members — the same rule as the project detail
 * route, so reading roles cannot be used to confirm a draft slug exists. Extracted rather
 * than repeated because the two routes must never disagree about it: a detail read with a
 * laxer gate than its list is a way to enumerate drafts one role id at a time.
 *
 * EXPORTED for the venture reel (`GET /:projectSlug/videos`), which is a third read of the
 * same project-scoped, draft-sensitive kind. The rule above is the reason it is shared and
 * not copied: three gates that must agree are three chances for one of them to drift.
 */
export async function resolveRoleVisibleProjectOrRespond(
  req: Request,
  res: Response,
): Promise<membershipService.ProjectRef | null> {
  const projectSlug = firstParam(req.params.projectSlug ?? "");
  const project = await membershipService.findProjectBySlug(projectSlug);

  if (!project) {
    respondProjectError(res, { type: "NOT_FOUND", projectRef: projectSlug });
    return null;
  }

  if (project.projectStatus === "draft") {
    const isMember =
      req.user !== undefined &&
      (await membershipService.isActiveProjectMember(project.projectId, req.user.id));

    if (!isMember) {
      respondProjectError(res, { type: "NOT_FOUND", projectRef: projectSlug });
      return null;
    }
  }

  return project;
}

/** GET /research-projects/:projectSlug/roles — public for a published project. */
export async function listRoles(req: Request, res: Response): Promise<void> {
  const project = await resolveRoleVisibleProjectOrRespond(req, res);
  if (!project) {
    return;
  }

  const roles = await rolesService.listOpenRolesForProject(project.projectId);

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Roles retrieved successfully",
    data: roles,
  };
  res.status(200).json(response);
}

/**
 * GET /research-projects/:projectSlug/roles/:roleId — public for a published project.
 *
 * Same visibility gate and same payload shape as the list above (§11j.2), so a role card
 * that links to its own detail page gets the identical object back.
 */
export async function getRole(req: Request, res: Response): Promise<void> {
  const project = await resolveRoleVisibleProjectOrRespond(req, res);
  if (!project) {
    return;
  }

  const roleId = firstParam(req.params.roleId ?? "");
  const role = await rolesService.findProjectOpenRoleView(project.projectId, roleId);

  if (!role) {
    respondProjectError(res, { type: "ROLE_NOT_FOUND", roleId });
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Role retrieved successfully",
    data: role,
  };
  res.status(200).json(response);
}

/** POST /research-projects/:projectSlug/roles */
export async function createRole(req: Request, res: Response): Promise<void> {
  const parsedBody = CreateOpenRoleSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const context = await requireRoleOrRespond(req, res, "maintainer");
  if (!context) {
    return;
  }

  const createResult = await rolesService.createOpenRole(context.projectId, parsedBody.data);
  if (!createResult.success) {
    respondProjectError(res, createResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 201,
    message: "Role created successfully",
    data: createResult.value,
  };
  res.status(201).json(response);
}

/** PATCH /research-projects/:projectSlug/roles/:roleId */
export async function updateRole(req: Request, res: Response): Promise<void> {
  const parsedBody = UpdateOpenRoleSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const context = await requireRoleOrRespond(req, res, "maintainer");
  if (!context) {
    return;
  }

  const roleId = firstParam(req.params.roleId ?? "");
  const updateResult = await rolesService.updateOpenRole(
    context.projectId,
    roleId,
    parsedBody.data,
  );
  if (!updateResult.success) {
    respondProjectError(res, updateResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Role updated successfully",
    data: updateResult.value,
  };
  res.status(200).json(response);
}

/** POST …/roles/:roleId/close and /reopen — editorial, independent of capacity. */
export async function closeRole(req: Request, res: Response): Promise<void> {
  await setRoleClosed(req, res, true);
}

export async function reopenRole(req: Request, res: Response): Promise<void> {
  await setRoleClosed(req, res, false);
}

async function setRoleClosed(req: Request, res: Response, shouldClose: boolean): Promise<void> {
  const context = await requireRoleOrRespond(req, res, "maintainer");
  if (!context) {
    return;
  }

  const roleId = firstParam(req.params.roleId ?? "");
  const result = await rolesService.setOpenRoleClosed(context.projectId, roleId, shouldClose);
  if (!result.success) {
    respondProjectError(res, result.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: shouldClose ? "Role closed successfully" : "Role reopened successfully",
    data: result.value,
  };
  res.status(200).json(response);
}

/** DELETE /research-projects/:projectSlug/roles/:roleId */
export async function deleteRole(req: Request, res: Response): Promise<void> {
  const context = await requireRoleOrRespond(req, res, "maintainer");
  if (!context) {
    return;
  }

  const roleId = firstParam(req.params.roleId ?? "");
  const deleteResult = await rolesService.deleteOpenRole(context.projectId, roleId);
  if (!deleteResult.success) {
    respondProjectError(res, deleteResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Role deleted successfully",
    data: deleteResult.value,
  };
  res.status(200).json(response);
}

/** GET /open-roles — the cross-project rail. Server-side filtering (§6). */
export async function listOpenRolesAcrossProjects(req: Request, res: Response): Promise<void> {
  const parsedQuery = ListOpenRolesQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const { commitment, skill, category, minEquityBasisPoints, page, limit } = parsedQuery.data;
  const rolesPage = await rolesService.listOpenRolesAcrossProjects({
    commitment,
    skill,
    categorySlug: category,
    minEquityBasisPoints,
    page,
    limit,
  });

  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message: "Open roles retrieved successfully",
    data: [...rolesPage.rows],
    pagination: {
      page,
      limit,
      total: rolesPage.total,
      totalPages: Math.ceil(rolesPage.total / limit),
    },
  };
  res.status(200).json(response);
}
