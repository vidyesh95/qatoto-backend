import type { Request, Response } from "express";
import { z } from "zod";

import {
  firstParam,
  respondDiscoveryError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/discovery-error-response.js";
import { respondProjectError } from "#src/controllers/project-error-response.js";
import * as readinessService from "#src/services/launch-readiness.service.js";
import * as membershipService from "#src/services/project-membership.service.js";
import * as suppliersService from "#src/services/suppliers.service.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

/**
 * Go-to-market — the supplier directory and launch readiness
 * (R_AND_D_BACKEND_STRUCTURE.md §11i, Appendix B4).
 *
 * ---------------------------------------------------------------------------
 * THE FIELDS THAT EXIST IN NO SCHEMA HERE, and are therefore 422s rather than silent
 * overwrites (§0, §13). Every one is server-owned:
 *
 *   id · createdAt · updatedAt · createdByUserId · isActive (on create) ·
 *   verificationState (on create) · slug (on update) · projectId · researchProjectId ·
 *   metCount · state · observedCount · asOf
 *
 * TWO OF THOSE ARE WORTH NAMING. `verificationState` is absent from the CREATE schema so a
 * new listing is always `unverified` — a directory whose rows assert their own trust level
 * is worse than no directory. And `slug` is absent from the UPDATE schema because it is
 * the public identity a client has already linked to; renaming it silently breaks every
 * stored reference, which is why `research_project` freezes its slug at publish too.
 *
 * READINESS IS COMPUTED, NEVER SUBMITTED. There is no POST that sets an item's state and no
 * body that carries one: `state` is derived from `research_project.stage`, `project_stats`,
 * the bake event, the engagement rows and the linked listings. A client that could assert
 * "met" would be asserting an input into a launch decision (§0).
 * ---------------------------------------------------------------------------
 */

const SlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Must be a lowercase, hyphen-separated slug");

const SUPPLIER_VERIFICATION_STATES = [
  "unverified",
  "documents_pending",
  "verified",
  "suspended",
] as const;

const SUPPLIER_CONTACT_POLICIES = ["via_platform", "direct_email", "no_contact"] as const;

/**
 * `capability` accepts one value or several, and several means AND.
 *
 * The union-then-transform shape is `ListTalentQuerySchema`'s verbatim: Express hands a
 * repeated query key back as an array, and normalizing here means the service only ever
 * sees a list.
 */
export const ListSuppliersQuerySchema = z
  .object({
    capability: z
      .union([SlugSchema, z.array(SlugSchema).max(10)])
      .transform((value) => (Array.isArray(value) ? value : [value]))
      .optional(),
    region: z.string().trim().min(1).max(60).optional(),
    verificationState: z.enum(SUPPLIER_VERIFICATION_STATES).optional(),
    page: z.coerce.number().int().min(1).max(500).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

export const CreateSupplierSchema = z
  .object({
    slug: SlugSchema,
    name: z.string().trim().min(1).max(120),
    summary: z.string().trim().max(2_000).optional(),
    regionSlug: z.string().trim().min(1).max(60).optional(),
    contactPolicy: z.enum(SUPPLIER_CONTACT_POLICIES).optional(),
    // Not `z.url()`: the host allowlist in the service is the check that matters, and a
    // schemeless link the frontend accepts must not 422 here after a green checkmark.
    websiteUrl: z.string().trim().min(1).max(2_048).optional(),
    // Integer days and integer units. Bounded here AND by a CHECK — the schema catches one
    // hostile payload, the constraint catches a value assembled across two requests.
    leadTimeDays: z.coerce.number().int().min(0).max(3_650).optional(),
    minimumOrderQuantity: z.coerce.number().int().min(0).max(100_000_000).optional(),
    capabilitySlugs: z.array(SlugSchema).max(20).default([]),
  })
  .strict();

export const UpdateSupplierSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    // Explicit null clears the field; absent leaves it alone. The two must stay
    // distinguishable or a name-only PATCH silently drops a summary.
    summary: z.string().trim().max(2_000).nullable().optional(),
    regionSlug: z.string().trim().min(1).max(60).nullable().optional(),
    verificationState: z.enum(SUPPLIER_VERIFICATION_STATES).optional(),
    contactPolicy: z.enum(SUPPLIER_CONTACT_POLICIES).optional(),
    websiteUrl: z.string().trim().min(1).max(2_048).nullable().optional(),
    leadTimeDays: z.coerce.number().int().min(0).max(3_650).nullable().optional(),
    minimumOrderQuantity: z.coerce.number().int().min(0).max(100_000_000).nullable().optional(),
    isActive: z.boolean().optional(),
    capabilitySlugs: z.array(SlugSchema).max(20).optional(),
  })
  .strict();

export const LaunchReadyProjectsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(500).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

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
