import type { Request, Response } from "express";
import { z } from "zod";

import {
  firstParam,
  respondProjectError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/project-error-response.js";
import * as membershipService from "#src/services/project-membership.service.js";
import * as rolesService from "#src/services/project-roles.service.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

/**
 * Open roles and their compensation strands.
 *
 * The compensation schema is a DISCRIMINATED UNION on `kind`, not a bag of optional
 * numbers, so a `salary` strand carrying an equity band is a parse error rather than a
 * row the DB CHECK has to reject (CLAUDE.md §3.2 — make illegal states unrepresentable).
 *
 * Every equity figure here is an ADVERTISED OFFER, bounded 0..10000. A real grant comes
 * only from §9's ledger, and there is no endpoint anywhere that writes one.
 */

const ROLE_COMMITMENTS = ["full_time", "part_time", "hobby"] as const;

/**
 * THE TWO POLICIES A CASH STRAND MAY ADVERTISE (§4d, §7A).
 *
 * `milestone_escrow_release` and `on_completion_escrow_release` are RETIRED. They forced
 * every salary and one-time strand through an escrow release, which meant a founder who
 * never ran a funding round here had no way to say "I pay this person from my own bank
 * account" — money-in gated data-out — and, worse, it made a wage conditional on a
 * Proof-of-Effort verdict, which §0 now forbids outright.
 *
 * They stay in the pgEnum so migration 0010's existing rows remain readable. Nothing new
 * may be written with them: this schema refuses them with a 422, and
 * `open_role_compensation_policy_pairing_ck` (migration 0019) refuses them at the column
 * level. Both, not either — a rule with no database behind it is a convention.
 */
const CASH_POLICIES = ["off_platform_payroll", "direct_transfer"] as const;

const MoneyInCentsSchema = z.number().int().min(0);
const BasisPointsSchema = z.number().int().min(0).max(10_000);

/**
 * One strand per kind, each carrying only its own columns.
 *
 * The `earnedAsPolicy` enum differs per branch on purpose: equity vests through Slicing
 * Pie, cash is paid by the company and reported here (§7A), and pairing them the other
 * way lets a founder advertise a mechanism that does not exist. The DB CHECK enforces the
 * same rule; this makes it a 422 with a field path instead of a 500.
 */
const CompensationStrandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("salary"),
      salaryMinInCentsPerMonth: MoneyInCentsSchema,
      salaryMaxInCentsPerMonth: MoneyInCentsSchema.optional(),
      earnedAsPolicy: z.enum(CASH_POLICIES),
      earnedAsNote: z.string().trim().max(500).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("one_time"),
      oneTimeMinInCents: MoneyInCentsSchema,
      oneTimeMaxInCents: MoneyInCentsSchema.optional(),
      earnedAsPolicy: z.enum(CASH_POLICIES),
      earnedAsNote: z.string().trim().max(500).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("equity"),
      equityBasisPointsMin: BasisPointsSchema,
      equityBasisPointsMax: BasisPointsSchema.optional(),
      earnedAsPolicy: z.literal("slicing_pie_vesting"),
      earnedAsNote: z.string().trim().max(500).optional(),
    })
    .strict(),
]);

const OpenRoleFieldsSchema = z.object({
  roleTitle: z.string().trim().min(1).max(120),
  skills: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  commitment: z.enum(ROLE_COMMITMENTS),
  // slotsFilledCount is ABSENT — it is a server-owned counter moved only by the accept
  // transaction, and `.strict()` rejects a client trying to set it.
  slotsTotal: z.number().int().min(1).max(50).optional(),
  description: z.string().trim().max(10_000).optional(),
  compensation: z.array(CompensationStrandSchema).max(3).optional(),
});

export const CreateOpenRoleSchema = OpenRoleFieldsSchema.strict();
export const UpdateOpenRoleSchema = OpenRoleFieldsSchema.strict().partial();

export const ListOpenRolesQuerySchema = z
  .object({
    commitment: z.enum(ROLE_COMMITMENTS).optional(),
    skill: z.string().trim().min(1).max(60).optional(),
    category: z.string().trim().min(1).optional(),
    minEquityBasisPoints: z.coerce.number().int().min(0).max(10_000).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

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

/** GET /research-projects/:projectSlug/roles — public for a published project. */
export async function listRoles(req: Request, res: Response): Promise<void> {
  const projectSlug = firstParam(req.params.projectSlug ?? "");
  const project = await membershipService.findProjectBySlug(projectSlug);

  if (!project) {
    respondProjectError(res, { type: "NOT_FOUND", projectRef: projectSlug });
    return;
  }

  // A draft's roles are visible only to its members — the same rule as the project
  // detail route, so listing roles cannot be used to confirm a draft slug exists.
  if (project.projectStatus === "draft") {
    if (!req.user) {
      respondProjectError(res, { type: "NOT_FOUND", projectRef: projectSlug });
      return;
    }
    const isMember = await membershipService.isActiveProjectMember(project.projectId, req.user.id);
    if (!isMember) {
      respondProjectError(res, { type: "NOT_FOUND", projectRef: projectSlug });
      return;
    }
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
