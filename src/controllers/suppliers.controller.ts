import type { Request, Response } from "express";

import {
  firstParam,
  respondDiscoveryError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/discovery-error-response.js";
import { respondGoToMarketError } from "#src/controllers/go-to-market-error-response.js";
import { respondProjectError } from "#src/controllers/project-error-response.js";
import {
  CreateSupplierEngagementSchema,
  CreateSupplierSchema,
  LaunchReadyProjectsQuerySchema,
  ListSupplierEngagementsQuerySchema,
  ListSuppliersQuerySchema,
  UpdateSupplierEngagementSchema,
  UpdateSupplierSchema,
} from "#src/schemas/suppliers.schemas.js";
import * as readinessService from "#src/services/launch-readiness.service.js";
import * as membershipService from "#src/services/project-membership.service.js";
import * as engagementsService from "#src/services/supplier-engagements.service.js";
import * as suppliersService from "#src/services/suppliers.service.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

/** `GET /supplier-capabilities` — the seeded vocabulary behind the filter chips. */
export async function listSupplierCapabilities(_req: Request, res: Response): Promise<void> {
  const capabilities = await suppliersService.listSupplierCapabilities();

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Supplier capabilities retrieved successfully",
    data: capabilities,
  } satisfies ApiResponse);
}

/** `GET /suppliers` — the directory. Public read, server-side filtering (§6). */
export async function listSuppliers(req: Request, res: Response): Promise<void> {
  const parsedQuery = ListSuppliersQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const { capability, region, verificationState, page, limit } = parsedQuery.data;
  const suppliersPage = await suppliersService.listSuppliers({
    capabilitySlugs: capability,
    regionSlug: region,
    verificationState,
    page,
    limit,
  });

  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message: "Suppliers retrieved successfully",
    data: [...suppliersPage.rows],
    pagination: {
      page,
      limit,
      total: suppliersPage.total,
      totalPages: Math.ceil(suppliersPage.total / limit),
    },
  };
  res.status(200).json(response);
}

/** `GET /suppliers/:supplierSlug` — detail. */
export async function getSupplier(req: Request, res: Response): Promise<void> {
  const supplierSlug = firstParam(req.params.supplierSlug ?? "");
  const found = await suppliersService.findSupplierBySlug(supplierSlug);

  if (!found.success) {
    respondDiscoveryError(res, found.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Supplier loaded.",
    data: found.value,
  } satisfies ApiResponse);
}

/**
 * `POST /suppliers` — MODERATOR ONLY, checked in-service before any slug is read.
 *
 * The capability refusal is a 403 that names the capability and no resource, so it is
 * identical for a valid payload and a garbage one — the route is not an oracle (§4a).
 */
export async function createSupplier(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = CreateSupplierSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const created = await suppliersService.createSupplier(req.user.id, parsedBody.data);
  if (!created.success) {
    respondDiscoveryError(res, created.error);
    return;
  }

  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Supplier listed.",
    data: created.value,
  } satisfies ApiResponse);
}

/** `PATCH /suppliers/:supplierId` — MODERATOR ONLY. Same capability-first ordering. */
export async function updateSupplier(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = UpdateSupplierSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const supplierId = firstParam(req.params.supplierId ?? "");
  const updated = await suppliersService.updateSupplier(req.user.id, supplierId, parsedBody.data);

  if (!updated.success) {
    respondDiscoveryError(res, updated.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Supplier updated.",
    data: updated.value,
  } satisfies ApiResponse);
}

/**
 * `GET /launch-ready-projects` — the rail the `/go-to-market` page ends on.
 *
 * Each row carries what the project actually LISTED, via `product.researchProjectId`. That
 * FK is the only thing R&D contributes to the store, and this is what it buys: without it
 * the rail can name a project but not show what it shipped.
 *
 * The CTA from here points at `/studio/products`. There is deliberately no create endpoint
 * on this router — proxying a product create through a research route would duplicate the
 * validation, pricing and ownership checks the store already owns.
 */
export async function listLaunchReadyProjects(req: Request, res: Response): Promise<void> {
  const parsedQuery = LaunchReadyProjectsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const { page, limit } = parsedQuery.data;
  const projectsPage = await suppliersService.listLaunchReadyProjects({ page, limit });

  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message: "Launch-ready projects retrieved successfully",
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

/**
 * `GET /research-projects/:projectSlug/launch-readiness` — member only, else 404.
 *
 * PROJECT-SCOPED, unlike everything else on this router, and deliberately: the checklist
 * reads `project_stats` and the bake state, which are the project's own private operating
 * numbers. Membership is proven from the slug via `requireProjectRole`, and failure is 404
 * so a stranger cannot probe which slugs exist.
 */
export async function getLaunchReadiness(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const projectSlug = firstParam(req.params.projectSlug ?? "");
  const accessResult = await membershipService.requireProjectRole(
    projectSlug,
    req.user.id,
    "contributor",
  );

  if (!accessResult.success) {
    respondProjectError(res, accessResult.error);
    return;
  }

  const readiness = await readinessService.computeLaunchReadiness(
    accessResult.value.projectId,
    accessResult.value.projectSlug,
  );

  if (readiness === null) {
    // `requireProjectRole` already proved the project exists, so this is only reachable if
    // its stats sidecar is missing — a reconciliation problem, not a client one.
    respondProjectError(res, { type: "NOT_FOUND", projectRef: projectSlug });
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Launch readiness computed.",
    data: readiness,
  } satisfies ApiResponse);
}

/**
 * Maintainer+ on the project in the path, or the same 404 a stranger gets.
 *
 * Never 403: the engagement list is a project's private supplier CRM, and a distinguishable
 * refusal would let anyone holding a session enumerate project slugs.
 */
async function requireEngagementRoleOrRespond(
  req: Request,
  res: Response,
): Promise<membershipService.ProjectMemberContext | null> {
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

  if (!accessResult.success) {
    respondGoToMarketError(res, accessResult.error);
    return null;
  }
  return accessResult.value;
}

/** GET /research-projects/:projectSlug/supplier-engagements — maintainer+ (§11j.5). */
export async function listSupplierEngagements(req: Request, res: Response): Promise<void> {
  const context = await requireEngagementRoleOrRespond(req, res);
  if (!context) return;

  const parsedQuery = ListSupplierEngagementsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const { status, page, limit } = parsedQuery.data;
  const engagementsPage = await engagementsService.listSupplierEngagements(context, {
    status,
    page,
    limit,
  });

  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message: "Supplier engagements retrieved successfully",
    data: [...engagementsPage.rows],
    pagination: {
      page,
      limit,
      total: engagementsPage.total,
      totalPages: Math.ceil(engagementsPage.total / limit),
    },
  };
  res.status(200).json(response);
}

/**
 * POST /research-projects/:projectSlug/supplier-engagements — maintainer+ (§11j.5).
 *
 * The write that makes `supplier_engaged` reachable at all. Launch readiness is derived on
 * read, so the gate flips to `met` on the very next GET — no job, no recompute.
 */
export async function createSupplierEngagement(req: Request, res: Response): Promise<void> {
  const context = await requireEngagementRoleOrRespond(req, res);
  if (!context) return;

  const parsedBody = CreateSupplierEngagementSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const created = await engagementsService.createSupplierEngagement(context, parsedBody.data);
  if (!created.success) {
    respondGoToMarketError(res, created.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 201,
    message: "Supplier engagement recorded",
    data: created.value,
  };
  res.status(201).json(response);
}

/** PATCH …/supplier-engagements/:engagementId — maintainer+ (§11j.5). */
export async function updateSupplierEngagement(req: Request, res: Response): Promise<void> {
  const context = await requireEngagementRoleOrRespond(req, res);
  if (!context) return;

  const parsedBody = UpdateSupplierEngagementSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const engagementId = firstParam(req.params.engagementId ?? "");
  const updated = await engagementsService.updateSupplierEngagement(
    context,
    engagementId,
    parsedBody.data,
  );

  if (!updated.success) {
    respondGoToMarketError(res, updated.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Supplier engagement updated",
    data: updated.value,
  };
  res.status(200).json(response);
}

/**
 * DELETE …/supplier-engagements/:engagementId — maintainer+ (§11j.5).
 *
 * A hard delete, for a row filed against the wrong supplier. Ending an engagement is
 * `PATCH { status: "ended" }`, which deliberately KEEPS `supplier_engaged` met.
 */
export async function deleteSupplierEngagement(req: Request, res: Response): Promise<void> {
  const context = await requireEngagementRoleOrRespond(req, res);
  if (!context) return;

  const engagementId = firstParam(req.params.engagementId ?? "");
  const deleted = await engagementsService.deleteSupplierEngagement(context, engagementId);

  if (!deleted.success) {
    respondGoToMarketError(res, deleted.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Supplier engagement deleted",
    data: deleted.value,
  };
  res.status(200).json(response);
}
