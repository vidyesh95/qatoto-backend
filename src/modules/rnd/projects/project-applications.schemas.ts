/**
 * Request schemas for project-applications, extracted from project-applications.controller.ts.
 *
 * WHY THESE ARE NOT IN THE CONTROLLER. They were the larger half of it — the handlers
 * did not begin until the file was already hundreds of lines deep — and they have a
 * second consumer that a controller cannot serve: `src/docs/openapi-rnd-bodies.ts`
 * generates request bodies from these schemas, and importing a controller to reach one
 * drags in its whole service and db graph.
 *
 * NOTHING ABOUT THE PARSE BOUNDARY MOVED. The controller imports these and every handler
 * still runs `safeParse` before any service call, returning 422 on failure
 * (CLAUDE.md §3.1). Types come from `z.infer` here, so a service takes its input type
 * from the schema rather than importing it back out of a controller.
 */
import { z } from "zod";

export const ROLE_COMMITMENTS = ["full_time", "part_time", "hobby"] as const;

export const APPLICATION_STATUSES = [
  "pending",
  "accepted",
  "declined",
  "withdrawn",
  "expired",
] as const;

export const INVITE_STATUSES = ["pending", "accepted", "declined", "revoked", "expired"] as const;

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
