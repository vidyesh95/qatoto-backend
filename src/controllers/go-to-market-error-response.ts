import type { Response } from "express";

import type { SupplierEngagementError } from "#src/services/supplier-engagements.service.js";

/**
 * The §11i/§11j.5 project-scoped go-to-market error mapper.
 *
 * A SEPARATE MAPPER FROM discovery-error-response.ts, even though `SupplierError` lives
 * there and these routes are about suppliers. The two files answer to DIFFERENT status
 * policies: discovery's 404 means "resource lookup", and its only 403 is the
 * platform-capability refusal decided before any id is read. `ProjectAccessError`'s
 * `NOT_FOUND` means "every authorization failure", which is a different rule for the same
 * status code. One exhaustive switch owning both is exactly the drift discovery was split
 * out of project-error-response.ts to avoid.
 *
 * Not project-error-response.ts either — its union is already large and its header says so,
 * and one-mapper-per-domain is the precedent set five times over (workshop, studio,
 * funding, compensation, proof-of-effort).
 *
 * THE STATUS POLICY (§4a/§13), restated because it is the part a reviewer checks:
 *   404 — every authorization and lookup failure. "No such project", "not a maintainer",
 *         "that engagement belongs to another project" and "no such supplier" are
 *         indistinguishable. A project's supplier list is its private CRM, and a
 *         distinguishable refusal would let a stranger enumerate project slugs.
 *   409 — lifecycle conflicts. Here, exactly one: an engagement already exists for the
 *         pair, which the unique index detects and which re-approaching resolves with a
 *         PATCH rather than a second row.
 *   422 — parse failures, emitted by `respondValidationFailed` before this mapper runs.
 *
 * THERE IS NO 403 IN THIS UNION, deliberately. Every refusal here is decided AFTER an id
 * has been read, so a 403 would disclose that the id exists.
 */
export type GoToMarketDomainError = SupplierEngagementError;

export function mapGoToMarketErrorToResponse(error: GoToMarketDomainError): {
  readonly statusCode: number;
  readonly message: string;
  readonly errors?: Readonly<Record<string, readonly string[]>>;
} {
  switch (error.type) {
    // --- 404: every authorization and lookup failure, all indistinguishable.
    case "NOT_FOUND":
      return { statusCode: 404, message: "Project not found." };
    case "ENGAGEMENT_NOT_FOUND":
      return { statusCode: 404, message: "Supplier engagement not found." };
    // Also what a RETIRED supplier returns: `isActive: false` is how a listing is removed,
    // and it reads exactly as one that never existed (§11i).
    case "SUPPLIER_NOT_FOUND":
      return { statusCode: 404, message: "Supplier not found." };

    // --- 409: lifecycle.
    case "ENGAGEMENT_ALREADY_EXISTS":
      return {
        statusCode: 409,
        message:
          "This project already has an engagement with that supplier. Update the existing one instead.",
      };

    default: {
      // Adding a variant to the service union without handling it here breaks the build,
      // which is the point (CLAUDE.md §3.2).
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled go-to-market error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export function respondGoToMarketError(res: Response, error: GoToMarketDomainError): void {
  const { statusCode, message, errors } = mapGoToMarketErrorToResponse(error);
  res.status(statusCode).json({ status: "error", statusCode, message, errors });
}
