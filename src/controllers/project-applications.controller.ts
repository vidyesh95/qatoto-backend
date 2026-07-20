import type { Request, Response } from "express";
import { z } from "zod";

import {
  firstParam,
  optionalBody,
  respondProjectError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/project-error-response.js";
import * as applicationsService from "#src/services/project-applications.service.js";
import * as membershipService from "#src/services/project-membership.service.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

/**
 * Applications (person → project) and invites (project → person).
 *
 * `kind` is ABSENT from CreateApplicationSchema on purpose: the server derives it from
 * whether `openRoleId` was sent, and `.strict()` turns a client-supplied `kind` into a
 * 422. That is what stops someone filing a `join_request` that claims a role, or a
 * `role_interest` with no role — states the DB CHECK also refuses.
 *
 * `applicantUserId` and `inviteeUserId` — note the asymmetry. The APPLICANT is always
 * the session (there is no field for it). The INVITEE is a body field, because inviting
 * someone else is the entire point of the endpoint; it is validated against the user
 * table and collapses every failure into one error to avoid a user-enumeration oracle.
 */

const ROLE_COMMITMENTS = ["full_time", "part_time", "hobby"] as const;
const APPLICATION_STATUSES = ["pending", "accepted", "declined", "withdrawn", "expired"] as const;
const INVITE_STATUSES = ["pending", "accepted", "declined", "revoked", "expired"] as const;

export const CreateApplicationSchema = z
  .object({
    openRoleId: z.string().trim().min(1).optional(),
    shortPitch: z.string().trim().min(1).max(5000),
    selectedSkills: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
    statedCommitment: z.enum(ROLE_COMMITMENTS),
    // The applicant's OWN ask. Permitted precisely because it is theirs — but it never
    // reaches the ledger, never influences a grant, and must render to a reviewer as
    // "applicant's stated expectation" (§5).
    expectedCompensationNote: z.string().trim().max(1000).optional(),
  })
  .strict();

export const CreateInviteSchema = z
  .object({
    inviteeUserId: z.string().trim().min(1),
    openRoleId: z.string().trim().min(1).optional(),
    message: z.string().trim().max(2000).optional(),
  })
  .strict();

/** Every decision body is entirely optional — see `optionalBody`. */
export const DecisionNoteSchema = z
  .object({ note: z.string().trim().max(2000).optional() })
  .strict();

export const ListApplicationsQuerySchema = z
  .object({
    status: z.enum(APPLICATION_STATUSES).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const ListInvitesQuerySchema = z
  .object({
    status: z.enum(INVITE_STATUSES).optional(),
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

/**
 * Resolves the project for a NON-MEMBER actor (an applicant, or an invitee answering).
 * Only a published project resolves — anything else is a 404, so a draft slug cannot be
 * confirmed by trying to apply to it.
 */
async function resolvePublicProjectOrRespond(
  req: Request,
  res: Response,
): Promise<membershipService.ProjectRef | null> {
  const projectSlug = firstParam(req.params.projectSlug ?? "");
  const project = await membershipService.findProjectBySlug(projectSlug);

  if (!project || project.projectStatus === "draft") {
    respondProjectError(res, { type: "NOT_FOUND", projectRef: projectSlug });
    return null;
  }
  return project;
}

/** GET /research-projects/:projectSlug/applications — maintainer+, founder-facing. */
export async function listApplications(req: Request, res: Response): Promise<void> {
  const parsedQuery = ListApplicationsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const context = await requireRoleOrRespond(req, res, "maintainer");
  if (!context) {
    return;
  }

  const { status, page, limit } = parsedQuery.data;
  const applicationsPage = await applicationsService.listApplications(context.projectId, {
    status,
    page,
    limit,
  });

  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message: "Applications retrieved successfully",
    data: [...applicationsPage.rows],
    pagination: {
      page,
      limit,
      total: applicationsPage.total,
      totalPages: Math.ceil(applicationsPage.total / limit),
    },
  };
  res.status(200).json(response);
}

/** POST /research-projects/:projectSlug/applications */
export async function createApplication(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = CreateApplicationSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const project = await resolvePublicProjectOrRespond(req, res);
  if (!project) {
    return;
  }

  // The applicant is the SESSION, never a body field.
  const createResult = await applicationsService.createApplication(
    project.projectId,
    req.user.id,
    parsedBody.data,
  );
  if (!createResult.success) {
    respondProjectError(res, createResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 201,
    message: "Application submitted successfully",
    data: createResult.value,
  };
  res.status(201).json(response);
}

/** POST …/applications/:applicationId/accept — maintainer+, one transaction. */
export async function acceptApplication(req: Request, res: Response): Promise<void> {
  const parsedBody = DecisionNoteSchema.safeParse(optionalBody(req));
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const context = await requireRoleOrRespond(req, res, "maintainer");
  if (!context || !req.user) {
    return;
  }

  const applicationId = firstParam(req.params.applicationId ?? "");
  const acceptResult = await applicationsService.acceptApplication(
    context.projectId,
    applicationId,
    req.user.id,
    parsedBody.data.note ?? null,
  );
  if (!acceptResult.success) {
    respondProjectError(res, acceptResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Application accepted successfully",
    data: acceptResult.value,
  };
  res.status(200).json(response);
}

/** POST …/applications/:applicationId/decline */
export async function declineApplication(req: Request, res: Response): Promise<void> {
  const parsedBody = DecisionNoteSchema.safeParse(optionalBody(req));
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const context = await requireRoleOrRespond(req, res, "maintainer");
  if (!context || !req.user) {
    return;
  }

  const applicationId = firstParam(req.params.applicationId ?? "");
  const declineResult = await applicationsService.declineApplication(
    context.projectId,
    applicationId,
    req.user.id,
    parsedBody.data.note ?? null,
  );
  if (!declineResult.success) {
    respondProjectError(res, declineResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Application declined",
    data: declineResult.value,
  };
  res.status(200).json(response);
}

/**
 * POST …/applications/:applicationId/withdraw — the APPLICANT only.
 *
 * No membership check: an applicant is by definition not a member. Ownership is
 * enforced inside the service's WHERE clause, so a stranger gets the same 404 as for a
 * nonexistent id.
 */
export async function withdrawApplication(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = DecisionNoteSchema.safeParse(optionalBody(req));
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const project = await resolvePublicProjectOrRespond(req, res);
  if (!project) {
    return;
  }

  const applicationId = firstParam(req.params.applicationId ?? "");
  const withdrawResult = await applicationsService.withdrawApplication(
    project.projectId,
    applicationId,
    req.user.id,
  );
  if (!withdrawResult.success) {
    respondProjectError(res, withdrawResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Application withdrawn",
    data: withdrawResult.value,
  };
  res.status(200).json(response);
}

/** GET /research-projects/:projectSlug/invites — maintainer+. */
export async function listInvites(req: Request, res: Response): Promise<void> {
  const parsedQuery = ListInvitesQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const context = await requireRoleOrRespond(req, res, "maintainer");
  if (!context) {
    return;
  }

  const { status, page, limit } = parsedQuery.data;
  const invitesPage = await applicationsService.listInvites(context.projectId, {
    status,
    page,
    limit,
  });

  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message: "Invites retrieved successfully",
    data: [...invitesPage.rows],
    pagination: {
      page,
      limit,
      total: invitesPage.total,
      totalPages: Math.ceil(invitesPage.total / limit),
    },
  };
  res.status(200).json(response);
}

/** POST /research-projects/:projectSlug/invites — maintainer+. */
export async function createInvite(req: Request, res: Response): Promise<void> {
  const parsedBody = CreateInviteSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const context = await requireRoleOrRespond(req, res, "maintainer");
  if (!context || !req.user) {
    return;
  }

  const createResult = await applicationsService.createInvite(
    context.projectId,
    req.user.id,
    parsedBody.data,
  );
  if (!createResult.success) {
    respondProjectError(res, createResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 201,
    message: "Invite sent successfully",
    data: createResult.value,
  };
  res.status(201).json(response);
}

/**
 * POST …/invites/:inviteId/accept — the INVITEE.
 *
 * This endpoint carries `requireIdentifiedUser` in the router, and that placement is
 * the load-bearing part: guarding only POST /invites would check the INVITER, while
 * this is the call that actually inserts a roster row. An identified founder inviting N
 * anonymous sessions, each accepting, would otherwise manufacture N sybil roster rows
 * that §9 would later apportion equity across.
 */
export async function acceptInvite(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const project = await resolvePublicProjectOrRespond(req, res);
  if (!project) {
    return;
  }

  const inviteId = firstParam(req.params.inviteId ?? "");
  const acceptResult = await applicationsService.acceptInvite(
    project.projectId,
    inviteId,
    req.user.id,
  );
  if (!acceptResult.success) {
    respondProjectError(res, acceptResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Invite accepted successfully",
    data: acceptResult.value,
  };
  res.status(200).json(response);
}

/** POST …/invites/:inviteId/decline — the INVITEE. */
export async function declineInvite(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const project = await resolvePublicProjectOrRespond(req, res);
  if (!project) {
    return;
  }

  const inviteId = firstParam(req.params.inviteId ?? "");
  const declineResult = await applicationsService.declineInvite(
    project.projectId,
    inviteId,
    req.user.id,
  );
  if (!declineResult.success) {
    respondProjectError(res, declineResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Invite declined",
    data: declineResult.value,
  };
  res.status(200).json(response);
}

/** DELETE /research-projects/:projectSlug/invites/:inviteId — maintainer+ revokes. */
export async function revokeInvite(req: Request, res: Response): Promise<void> {
  const context = await requireRoleOrRespond(req, res, "maintainer");
  if (!context) {
    return;
  }

  const inviteId = firstParam(req.params.inviteId ?? "");
  const revokeResult = await applicationsService.revokeInvite(context.projectId, inviteId);
  if (!revokeResult.success) {
    respondProjectError(res, revokeResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Invite revoked",
    data: revokeResult.value,
  };
  res.status(200).json(response);
}
