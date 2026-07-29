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
  // The actor is passed so the notification can name who revoked it — and so the service
  // can drop a self-notification if a maintainer ever revokes their own invite.
  const revokeResult = await applicationsService.revokeInvite(
    context.projectId,
    inviteId,
    req.user?.id ?? "",
  );
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

/**
 * GET /applications/mine — root-mounted, `requireAuth` (§11j.2).
 *
 * There is no `userId` query parameter and there must never be one (§13): the filter is
 * `req.user.id`. The project-scoped list is the founder's inbox and is maintainer-gated,
 * so it can never answer this question for the person who applied.
 */
export async function listMyApplications(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedQuery = ListApplicationsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const { status, page, limit } = parsedQuery.data;
  const applicationsPage = await applicationsService.listMyApplications(req.user.id, {
    status,
    page,
    limit,
  });

  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message: "Your applications retrieved successfully",
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

/**
 * GET /invites/mine — root-mounted, `requireAuth` (§11j.2).
 *
 * The read that makes the talent-page invite flow terminate somewhere: `/accept` and
 * `/decline` both need an `inviteId`, and the invitee previously had no way to obtain one.
 */
export async function listMyInvites(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedQuery = ListInvitesQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const { status, page, limit } = parsedQuery.data;
  const invitesPage = await applicationsService.listMyInvites(req.user.id, {
    status,
    page,
    limit,
  });

  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message: "Your invites retrieved successfully",
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

/**
 * Resolves a project for a caller who is EITHER a maintainer of it OR the counterparty of
 * the row being read (§11j.2) — the one dual-standing read in this file.
 *
 * Maintainer standing is tried first and, when it holds, wins outright: it covers drafts,
 * which is the founder inbox's whole job. When it does not, the caller may still be the
 * applicant or invitee, so the project is resolved WITHOUT a membership requirement and the
 * row's own counterparty column decides.
 *
 * `findProjectBySlug`, NOT `resolvePublicProjectOrRespond`: the latter 404s a draft, which
 * would hide an applicant's own application the moment a founder unpublishes — punishing
 * the applicant for something only the founder did.
 *
 * Returns the project plus whether maintainer standing was proven; every failure path
 * writes the same 404 and returns null, so "no such project", "not a maintainer" and "not
 * your row" are indistinguishable.
 */
async function resolveCounterpartyProjectOrRespond(
  req: Request,
  res: Response,
): Promise<{
  readonly project: membershipService.ProjectRef;
  readonly isMaintainer: boolean;
} | null> {
  if (!req.user) {
    respondUnauthenticated(res);
    return null;
  }

  const projectSlug = firstParam(req.params.projectSlug ?? "");
  const accessResult = await membershipService.requireProjectRole(
    projectSlug,
    req.user.id,
    "maintainer",
  );

  if (accessResult.success) {
    return {
      project: {
        projectId: accessResult.value.projectId,
        projectSlug: accessResult.value.projectSlug,
        projectStatus: accessResult.value.projectStatus,
        founderUserId: accessResult.value.founderUserId,
        currency: accessResult.value.currency,
      },
      isMaintainer: true,
    };
  }

  const project = await membershipService.findProjectBySlug(projectSlug);
  if (!project) {
    respondProjectError(res, { type: "NOT_FOUND", projectRef: projectSlug });
    return null;
  }
  return { project, isMaintainer: false };
}

/**
 * GET /research-projects/:projectSlug/applications/:applicationId (§11j.2).
 *
 * The applicant or a maintainer+; everything else, including an id belonging to another
 * project, is the same 404.
 */
export async function getApplication(req: Request, res: Response): Promise<void> {
  const resolved = await resolveCounterpartyProjectOrRespond(req, res);
  if (!resolved) {
    return;
  }

  const applicationId = firstParam(req.params.applicationId ?? "");
  const application = await applicationsService.findApplicationById(
    resolved.project.projectId,
    applicationId,
  );

  // A non-maintainer sees ONLY their own row, and a row that is not theirs answers exactly
  // as one that does not exist.
  if (!application || (!resolved.isMaintainer && application.applicantUserId !== req.user?.id)) {
    respondProjectError(res, { type: "APPLICATION_NOT_FOUND", applicationId });
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Application retrieved successfully",
    data: application,
  };
  res.status(200).json(response);
}

/**
 * GET /research-projects/:projectSlug/invites/:inviteId (§11j.2).
 *
 * The invitee or a maintainer+. Same shape and same reasoning as `getApplication`.
 */
export async function getInvite(req: Request, res: Response): Promise<void> {
  const resolved = await resolveCounterpartyProjectOrRespond(req, res);
  if (!resolved) {
    return;
  }

  const inviteId = firstParam(req.params.inviteId ?? "");
  const invite = await applicationsService.findInviteById(resolved.project.projectId, inviteId);

  if (!invite || (!resolved.isMaintainer && invite.inviteeUserId !== req.user?.id)) {
    respondProjectError(res, { type: "INVITE_NOT_FOUND", inviteId });
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Invite retrieved successfully",
    data: invite,
  };
  res.status(200).json(response);
}
