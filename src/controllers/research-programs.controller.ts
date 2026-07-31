import type { Request, Response } from "express";
import { z } from "zod";

import {
  firstParam,
  optionalBody,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/project-error-response.js";
import { respondResearchProgramError } from "#src/controllers/research-program-error-response.js";
import { decodeInstantCursor, type InstantCursor } from "#src/lib/instant-cursor.js";
import {
  requirePlatformCapability,
  type PlatformStaffContext,
} from "#src/services/platform-role.service.js";
import * as categoriesService from "#src/services/research-paper-categories.service.js";
import * as papersService from "#src/services/research-papers.service.js";
import {
  findParticipant,
  hasAnyPlatformRole,
  requireProgramOwner,
  requireProgramVisible,
  requireProgramWritable,
  type ProgramContext,
} from "#src/services/research-program-access.service.js";
import * as branchesService from "#src/services/research-program-branches.service.js";
import * as moderationService from "#src/services/research-program-moderation.service.js";
import * as opportunitiesService from "#src/services/research-program-opportunities.service.js";
import * as participantsService from "#src/services/research-program-participants.service.js";
import * as postsService from "#src/services/research-program-posts.service.js";
import * as programsService from "#src/services/research-programs.service.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

/**
 * §10 research programs — the whole HTTP surface
 * (R_AND_D_BACKEND_STRUCTURE.md §10, §11f).
 *
 * SCHEMAS LIVE HERE, not in a separate file, matching `proof-of-effort.controller.ts`.
 * Every one is `.strict()`, which is what makes an attempt to send a server-owned field a
 * 422 rather than a silently ignored key — and on this surface the server-owned fields are
 * the ones that matter most:
 *
 *   `research_program.status`                      → publishing is a moderator's decision
 *   `research_program_branch.status`                → derived by `recompute-branch-signals`
 *   `research_program_branch.overlappingGroupCount` → same
 *   `research_program_branch.ancestorPath`          → derived from the parent chain
 *   `research_program_branch.siblingOrder` on CREATE → derived from existing siblings
 *   `research_program_paper.contentSha256` / `fileByteSize` / `objectStorageKey`
 *                                                   → measured from the bytes
 *   `research_program_paper.moderationStatus`        → a reviewer's verdict
 *   `research_program_post.reactionCount` / `replyCount` / `depth` / `isHidden`
 *
 * None of them appears in any schema below. That is the §10 half of the zero-trust rule:
 * the two branch signals in particular are the intellectual core of the surface, and a
 * contributor able to set them would make the research map worthless.
 *
 * AUTHORIZATION, three shapes, and the ORDER matters in the third:
 *
 *   `resolveVisibleProgram`   — a read. 404 for pending/rejected unless creator or staff.
 *   `resolveWritableProgram`  — a contribution. Adds "must be published".
 *   `resolveStaff`            — a moderation action. The capability is proven BEFORE any id
 *                               is read, so its 403 cannot be used as an id oracle
 *                               (`platform-role.service.ts`).
 */

// ---------------------------------------------------------------------------
// Shared query fragments
// ---------------------------------------------------------------------------

/** Offset pagination, bounded. Matches the shape every other R&D list query uses. */
const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Keyset pagination. `cursor` is decoded in the controller so a bad one is a 422. */
const CursorQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().trim().min(1).max(200).optional(),
});

/** `YYYY-MM-DD`, the §1 wire format. Never a `Date`, which a zone would shift. */
const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD");

/**
 * Client-minted, once per attempt. 8–128 characters mirrors the DB CHECK, and the length
 * floor is what stops a caller from sending `"1"` and colliding with everyone else's `"1"`.
 */
const IdempotencyKeySchema = z.string().trim().min(8).max(128);

// ---------------------------------------------------------------------------
// Program lifecycle
// ---------------------------------------------------------------------------

/**
 * `status` is ABSENT, and that absence is the review gate. A user-minted program always
 * lands `pending`; `.strict()` turns an attempt to add the key into a 422 rather than
 * letting one field bypass moderation. Same construction as `CreateCategorySchema`.
 */
export const CreateProgramSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    tagline: z.string().trim().min(3).max(200),
    missionStatement: z.string().trim().min(20).max(4000),
  })
  .strict();

/** No `status`, and no `slug` — a published slug has been linked and cited. */
export const UpdateProgramSchema = z
  .object({
    title: z.string().trim().min(3).max(120).optional(),
    tagline: z.string().trim().min(3).max(200).optional(),
    missionStatement: z.string().trim().min(20).max(4000).optional(),
  })
  .strict();

/**
 * The reviewer's note is REQUIRED, on both decisions. "No" without a reason is not a
 * review, and the note is the only thing the person who submitted will see.
 */
export const ModerateProgramSchema = z
  .object({
    decision: z.enum(["published", "rejected"]),
    reviewerNote: z.string().trim().min(1).max(2000),
  })
  .strict();

export const ListProgramsQuerySchema = PageQuerySchema.extend({
  q: z.string().trim().min(1).max(120).optional(),
}).strict();

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

/**
 * `status`, `overlappingGroupCount`, `ancestorPath` and `siblingOrder` are all absent.
 * The first two are job-derived (§10 rule 1) and the last two are computed from the tree.
 */
export const CreateBranchSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    summary: z.string().trim().min(10).max(2000),
    parentBranchId: z.string().trim().min(1).max(64).nullable().default(null),
  })
  .strict();

/**
 * `siblingOrder` IS accepted here, unlike on create — reordering is an explicit,
 * deliberate act, whereas on create it would just be a client racing other clients.
 *
 * The two pinned per-mille values are the curator override §10 allows. `.nullable()` so a
 * curator can clear a pin and hand the node back to the client's tidy layout.
 */
export const UpdateBranchSchema = z
  .object({
    title: z.string().trim().min(3).max(120).optional(),
    summary: z.string().trim().min(10).max(2000).optional(),
    parentBranchId: z.string().trim().min(1).max(64).nullable().optional(),
    siblingOrder: z.coerce.number().int().min(0).max(10_000).optional(),
    pinnedLeftPermille: z.coerce.number().int().min(0).max(1000).nullable().optional(),
    pinnedTopPermille: z.coerce.number().int().min(0).max(1000).nullable().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Papers
// ---------------------------------------------------------------------------

/**
 * Every file fact is absent — size, hash and storage key are MEASURED from the bytes, and
 * `moderationStatus` is a reviewer's verdict.
 *
 * `doi` is loosely shaped here and normalized in the service, because the value people
 * paste is `https://doi.org/10.1234/abc` at least as often as the bare form.
 */
export const CreatePaperSchema = z
  .object({
    title: z.string().trim().min(3).max(300),
    categoryId: z.string().trim().min(1).max(64),
    branchId: z.string().trim().min(1).max(64).nullable().default(null),
    doi: z.string().trim().min(3).max(200).nullable().default(null),
    authorAffiliation: z.string().trim().min(1).max(200).nullable().default(null),
    abstractText: z.string().trim().min(1).max(5000).nullable().default(null),
  })
  .strict();

/**
 * The multipart route's body. There is deliberately NOTHING in it beyond the idempotency
 * key: the file is the payload and every fact about it is measured server-side.
 */
export const AttachPaperFileSchema = z.object({ idempotencyKey: IdempotencyKeySchema }).strict();

export const ModeratePaperSchema = z
  .object({
    decision: z.enum(["approved", "rejected", "needs_changes"]),
    reviewerNote: z.string().trim().min(1).max(2000),
    // Moderator-supplied, and capped to match the DB CHECK.
    flagReasons: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
  })
  .strict();

export const ListPapersQuerySchema = CursorQuerySchema.extend({
  categoryId: z.string().trim().min(1).max(64).optional(),
  branchId: z.string().trim().min(1).max(64).optional(),
  moderationStatus: z.enum(["queued", "approved", "rejected", "needs_changes"]).optional(),
}).strict();

export const CreatePaperCategorySchema = z
  .object({ label: z.string().trim().min(2).max(80) })
  .strict();

export const ListPaperCategoriesQuerySchema = z
  .object({ status: z.enum(["approved", "pending", "rejected"]).default("approved") })
  .strict();

/**
 * A discriminated union, mirroring §6's `DecideCategorySchema`: a rejection REQUIRES a note and
 * an approval does not, which one flat object with an optional note could not express.
 *
 * No `pinIconKey` arm — that column belongs to the project taxonomy's problem map, and the
 * paper taxonomy has no equivalent.
 */
export const DecidePaperCategorySchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("approve"),
      note: z.string().trim().max(2_000).optional(),
    })
    .strict(),
  z
    .object({
      decision: z.literal("reject"),
      note: z.string().trim().min(1).max(2_000),
    })
    .strict(),
]);

// ---------------------------------------------------------------------------
// Posts, reactions, reports
// ---------------------------------------------------------------------------

/**
 * `depth`, `parentPostId`, `reactionCount`, `replyCount` and `isHidden` are all absent.
 * A reply goes through `POST …/replies`, where the parent is a path parameter — so a
 * client cannot mint a reply at an arbitrary depth by choosing its own parent field.
 */
export const CreatePostSchema = z
  .object({
    track: z.enum(["informal_paper", "idea"]),
    title: z.string().trim().min(3).max(200).nullable().default(null),
    bodyText: z.string().trim().min(1).max(10_000),
    /**
     * Which branch this thread is about. NULL for a program-wide one.
     *
     * Accepted on a top-level post only — a REPLY inherits its parent's, which is why
     * `CreateReplySchema` has no such field. Letting a reply re-file itself would move half a
     * conversation to another branch.
     */
    branchId: z.string().trim().min(1).max(64).nullable().default(null),
  })
  .strict()
  // The CHECK enforces the same rule; refusing it here names the field instead of the
  // constraint, and turns a would-be 500 into an actionable 422.
  .refine((body) => (body.track === "informal_paper" ? body.title !== null : body.title === null), {
    message: "An informal paper needs a title; an idea must not have one.",
    path: ["title"],
  });

export const CreateReplySchema = z
  .object({ bodyText: z.string().trim().min(1).max(10_000) })
  .strict();

export const ReportContentSchema = z
  .object({
    reason: z.enum(["spam", "plagiarism", "misinformation", "harassment", "off_topic", "other"]),
    detailText: z.string().trim().min(1).max(2000).nullable().default(null),
  })
  .strict();

export const ModeratePostSchema = z
  .object({
    decision: z.enum(["hidden", "restored"]),
    reasonNote: z.string().trim().min(1).max(2000),
  })
  .strict();

export const DismissReportSchema = z
  .object({ reasonNote: z.string().trim().min(1).max(2000) })
  .strict();

export const ListPostsQuerySchema = CursorQuerySchema.extend({
  track: z.enum(["informal_paper", "idea"]).default("idea"),
}).strict();

// ---------------------------------------------------------------------------
// Participants, effort, contributions, opportunities
// ---------------------------------------------------------------------------

const PARTICIPANT_ROLES = [
  "researcher",
  "founder_director",
  "venture_capitalist",
  "supplier",
  "supporter",
] as const;

/** `snake_case`, because these are Postgres `pgEnum` labels sent verbatim (§ wire casing). */
const COMPENSATION_PREFERENCES = ["salary", "one_time", "equity"] as const;

export const JoinProgramSchema = z
  .object({
    role: z.enum(PARTICIPANT_ROLES),
    compensationPreference: z.enum(COMPENSATION_PREFERENCES),
    contributionSummary: z.string().trim().min(1).max(500).nullable().default(null),
    fundingTrancheIndex: z.coerce.number().int().min(1).max(100).nullable().default(null),
    fundingTrancheTotal: z.coerce.number().int().min(1).max(100).nullable().default(null),
  })
  .strict();

export const UpdateParticipationSchema = z
  .object({
    role: z.enum(PARTICIPANT_ROLES).optional(),
    compensationPreference: z.enum(COMPENSATION_PREFERENCES).optional(),
    contributionSummary: z.string().trim().min(1).max(500).nullable().optional(),
    fundingTrancheIndex: z.coerce.number().int().min(1).max(100).nullable().optional(),
    fundingTrancheTotal: z.coerce.number().int().min(1).max(100).nullable().optional(),
  })
  .strict();

export const LogEffortSchema = z
  .object({
    // 1440 is one day. The CHECK says the same; this makes it a 422 with a field name.
    minutes: z.coerce.number().int().min(1).max(1440),
    branchId: z.string().trim().min(1).max(64).nullable().default(null),
    loggedForDate: IsoDateSchema,
    note: z.string().trim().min(1).max(2000),
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();

export const RecordContributionSchema = z
  .object({
    kind: z.enum(["cash_commitment", "material", "data", "equipment", "expertise"]),
    /**
     * A DECIMAL STRING, not a number — the convention every money body in this codebase
     * follows (`CentsStringSchema`). A JS number cannot carry a bigint cent amount safely,
     * and `estimatedMarketSizeInCents`-scale values are exactly why the column is bigint.
     */
    amountInCents: z
      .string()
      .regex(/^\d{1,15}$/)
      .nullable()
      .default(null),
    currencyCode: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable()
      .default(null),
    description: z.string().trim().min(1).max(1000),
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();

export const CreateOpportunitySchema = z
  .object({
    productName: z.string().trim().min(3).max(200),
    productDescription: z.string().trim().min(10).max(2000),
    derivedFromBranchId: z.string().trim().min(1).max(64),
    /** bigint cents as a decimal string — "$12B" is 1200000000000, 560× the int4 ceiling. */
    estimatedMarketSizeInCents: z.string().regex(/^\d{1,15}$/),
    readinessMinMonths: z.coerce.number().int().min(0).max(600),
    readinessMaxMonths: z.coerce.number().int().min(0).max(600),
  })
  .strict();

export const ListParticipantsQuerySchema = PageQuerySchema.extend({
  role: z.enum(PARTICIPANT_ROLES).optional(),
}).strict();

// ---------------------------------------------------------------------------
// Authorization helpers
// ---------------------------------------------------------------------------

/**
 * Resolves a program the caller may READ, responding on failure.
 *
 * Signed-out callers are fine — a published program is public. Staff standing is resolved
 * first, but with `hasAnyPlatformRole` rather than a capability check, because this is only
 * deciding whether an unpublished program is VISIBLE, not whether an action is permitted.
 * A moderator who can see a pending program still needs `moderate_content` to decide it.
 */
async function resolveVisibleProgram(req: Request, res: Response): Promise<ProgramContext | null> {
  const programSlug = firstParam(req.params.programSlug ?? "");
  const viewerUserId = req.user?.id ?? null;
  const isStaff = viewerUserId === null ? false : await hasAnyPlatformRole(viewerUserId);

  const result = await requireProgramVisible(programSlug, viewerUserId, isStaff);
  if (!result.success) {
    respondResearchProgramError(res, result.error);
    return null;
  }
  return result.value;
}

/** Resolves a program the caller may CONTRIBUTE to. Requires a session. */
async function resolveWritableProgram(
  req: Request,
  res: Response,
): Promise<{ readonly program: ProgramContext; readonly userId: string } | null> {
  if (!req.user) {
    respondUnauthenticated(res);
    return null;
  }
  const programSlug = firstParam(req.params.programSlug ?? "");
  const isStaff = await hasAnyPlatformRole(req.user.id);

  const result = await requireProgramWritable(programSlug, req.user.id, isStaff);
  if (!result.success) {
    respondResearchProgramError(res, result.error);
    return null;
  }
  return { program: result.value, userId: req.user.id };
}

/** Resolves a program the caller OWNS. */
async function resolveOwnedProgram(
  req: Request,
  res: Response,
): Promise<{ readonly program: ProgramContext; readonly userId: string } | null> {
  if (!req.user) {
    respondUnauthenticated(res);
    return null;
  }
  const programSlug = firstParam(req.params.programSlug ?? "");

  const result = await requireProgramOwner(programSlug, req.user.id);
  if (!result.success) {
    respondResearchProgramError(res, result.error);
    return null;
  }
  return { program: result.value, userId: req.user.id };
}

/**
 * Proves `moderate_content` BEFORE any id is read.
 *
 * That ordering is a hard requirement, not a style choice: reversed, a non-staff caller
 * would learn whether a program slug exists before being refused, which turns the 403 into
 * an id oracle for anyone holding a session.
 */
async function resolveStaff(req: Request, res: Response): Promise<PlatformStaffContext | null> {
  if (!req.user) {
    respondUnauthenticated(res);
    return null;
  }
  const capabilityResult = await requirePlatformCapability(req.user.id, "moderate_content");
  if (!capabilityResult.success) {
    respondResearchProgramError(res, capabilityResult.error);
    return null;
  }
  return capabilityResult.value;
}

/**
 * A staff-scoped program lookup, in the required order: capability, THEN the slug.
 *
 * Returns the program context too, because every moderation route needs the id and
 * re-reading it would be a second query for something already loaded.
 */
async function resolveStaffProgram(
  req: Request,
  res: Response,
): Promise<{ readonly staff: PlatformStaffContext; readonly program: ProgramContext } | null> {
  const staff = await resolveStaff(req, res);
  if (!staff) return null;

  const programSlug = firstParam(req.params.programSlug ?? "");
  const result = await requireProgramVisible(programSlug, staff.staffUserId, true);
  if (!result.success) {
    respondResearchProgramError(res, result.error);
    return null;
  }
  return { staff, program: result.value };
}

/**
 * Decodes a keyset cursor, answering 422 on a malformed one.
 *
 * NEVER a silent first page: a client that silently restarts a feed shows duplicates and
 * reports it as a backend bug. That contract is set by §11h and shared by every keyset read
 * in this codebase.
 */
function decodeCursorOrRespond(
  res: Response,
  rawCursor: string | undefined,
): { readonly ok: true; readonly cursor: InstantCursor | undefined } | { readonly ok: false } {
  if (rawCursor === undefined) return { ok: true, cursor: undefined };

  const decoded = decodeInstantCursor(rawCursor);
  if (decoded === null) {
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "Malformed cursor.",
    } satisfies ApiResponse);
    return { ok: false };
  }
  return { ok: true, cursor: decoded };
}

function respondOk(res: Response, message: string, data: unknown): void {
  res.status(200).json({ status: "success", statusCode: 200, message, data } satisfies ApiResponse);
}

function respondCreated(res: Response, message: string, data: unknown): void {
  res.status(201).json({ status: "success", statusCode: 201, message, data } satisfies ApiResponse);
}

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------

/** `GET /research-programs` — the public index. Published and archived only. */
export async function listPrograms(req: Request, res: Response): Promise<void> {
  const parsedQuery = ListProgramsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }
  const { page, limit, q } = parsedQuery.data;

  const programPage = await programsService.listPublicResearchPrograms({
    page,
    limit,
    ...(q === undefined ? {} : { searchText: q }),
  });

  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message: "Research programs loaded.",
    data: [...programPage.rows],
    pagination: {
      page,
      limit,
      total: programPage.total,
      totalPages: Math.ceil(programPage.total / limit),
    },
  };
  res.status(200).json(response);
}

/** `GET /research-programs/slugs` — for the frontend's `generateStaticParams`. */
export async function listProgramSlugs(_req: Request, res: Response): Promise<void> {
  const slugs = await programsService.listPublishedProgramSlugs();
  respondOk(res, "Research program slugs loaded.", slugs);
}

/** `GET /research-programs/mine` — own programs at any status, including `pending`. */
export async function listOwnPrograms(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const programs = await programsService.listOwnResearchPrograms(req.user.id);
  respondOk(res, "Your research programs loaded.", programs);
}

/** `GET /research-programs/review-queue` — `pending` programs, oldest first. Moderator only. */
export async function listProgramReviewQueue(req: Request, res: Response): Promise<void> {
  const staff = await resolveStaff(req, res);
  if (!staff) return;

  const parsedQuery = PageQuerySchema.strict().safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }
  const { page, limit } = parsedQuery.data;

  const queuePage = await programsService.listProgramsAwaitingReview({ page, limit });

  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message: "Programs awaiting review loaded.",
    data: [...queuePage.rows],
    pagination: {
      page,
      limit,
      total: queuePage.total,
      totalPages: Math.ceil(queuePage.total / limit),
    },
  };
  res.status(200).json(response);
}

/** `POST /research-programs` — proposes one. Lands `pending`. */
export async function createProgram(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const parsedBody = CreateProgramSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const created = await programsService.createResearchProgram({
    ...parsedBody.data,
    createdByUserId: req.user.id,
  });
  if (!created.success) {
    respondResearchProgramError(res, created.error);
    return;
  }

  respondCreated(
    res,
    // Says what actually happened. A "created!" that omits the review step would have
    // someone waiting for a program to appear on an index it is deliberately absent from.
    "Program submitted for review. It stays private until a moderator publishes it.",
    created.value,
  );
}

/** `GET /research-programs/:programSlug` — public detail. */
export async function getProgram(req: Request, res: Response): Promise<void> {
  const program = await resolveVisibleProgram(req, res);
  if (!program) return;

  const viewerUserId = req.user?.id ?? null;
  const isStaff = viewerUserId === null ? false : await hasAnyPlatformRole(viewerUserId);

  const detail = await programsService.findResearchProgramDetail(
    program.programId,
    viewerUserId,
    isStaff,
  );
  if (!detail) {
    // Deleted between the visibility read and this one. Treated as absent, which it is.
    respondResearchProgramError(res, { type: "NOT_FOUND", programRef: program.programSlug });
    return;
  }

  const viewerParticipant =
    viewerUserId === null ? null : await findParticipant(program.programId, viewerUserId);

  respondOk(res, "Research program loaded.", {
    ...detail,
    /** So the UI offers "join" or "edit your participation" without a second request. */
    isViewerParticipant: viewerParticipant !== null,
  });
}

/**
 * `GET /research-programs/:programSlug/stats` — the four hero tiles.
 *
 * **404 when the job has never run.** Never a fabricated set of zeroes: four zeroes render
 * as "this program has nobody and nothing", when the truth is "nobody has counted yet".
 * Same ruling §7 makes for investor confidence.
 */
export async function getProgramStats(req: Request, res: Response): Promise<void> {
  const program = await resolveVisibleProgram(req, res);
  if (!program) return;

  const stats = await programsService.findLatestProgramStats(program.programId);
  if (!stats) {
    res.status(404).json({
      status: "error",
      statusCode: 404,
      message: "Program statistics have not been computed yet.",
    } satisfies ApiResponse);
    return;
  }
  respondOk(res, "Program statistics loaded.", stats);
}

/** `PATCH /research-programs/:programSlug` — creator only. No `status`, no `slug`. */
export async function updateProgram(req: Request, res: Response): Promise<void> {
  const owned = await resolveOwnedProgram(req, res);
  if (!owned) return;

  const parsedBody = UpdateProgramSchema.safeParse(optionalBody(req));
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  await programsService.updateResearchProgram(owned.program.programId, parsedBody.data);

  const detail = await programsService.findResearchProgramDetail(
    owned.program.programId,
    owned.userId,
  );
  respondOk(res, "Research program updated.", detail);
}

/** `POST /research-programs/:programSlug/moderate` — publish or reject. Moderator only. */
export async function moderateProgram(req: Request, res: Response): Promise<void> {
  // Capability first, slug second — see `resolveStaff`.
  const staff = await resolveStaff(req, res);
  if (!staff) return;

  const parsedBody = ModerateProgramSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const decided = await moderationService.decideProgramPublication({
    programSlug: firstParam(req.params.programSlug ?? ""),
    decision: parsedBody.data.decision,
    reviewerNote: parsedBody.data.reviewerNote,
    staff,
  });
  if (!decided.success) {
    respondResearchProgramError(res, decided.error);
    return;
  }

  respondOk(
    res,
    parsedBody.data.decision === "published"
      ? "Program published. It is now public and open to contributions."
      : "Program rejected. Its creator has been notified with your note.",
    decided.value,
  );
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

/** `GET …/branches` — the whole tree in one read. Public. */
export async function listBranches(req: Request, res: Response): Promise<void> {
  const program = await resolveVisibleProgram(req, res);
  if (!program) return;

  const branches = await branchesService.listProgramBranches(
    program.programId,
    req.user?.id ?? null,
  );
  respondOk(res, "Research branches loaded.", branches);
}

/** `POST …/branches` — anyone signed in, on a published program. */
export async function createBranch(req: Request, res: Response): Promise<void> {
  const writable = await resolveWritableProgram(req, res);
  if (!writable) return;

  const parsedBody = CreateBranchSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const created = await branchesService.createProgramBranch({
    programId: writable.program.programId,
    title: parsedBody.data.title,
    summary: parsedBody.data.summary,
    parentBranchId: parsedBody.data.parentBranchId,
    createdByUserId: writable.userId,
  });
  if (!created.success) {
    respondResearchProgramError(res, created.error);
    return;
  }

  respondCreated(
    res,
    // Says out loud that the two map signals are not the author's to set.
    "Research branch created. Its status and overlap flags are computed nightly.",
    created.value,
  );
}

/** `PATCH …/branches/:branchId` — the branch's author, the program's creator, or staff. */
export async function updateBranch(req: Request, res: Response): Promise<void> {
  const writable = await resolveWritableProgram(req, res);
  if (!writable) return;

  const parsedBody = UpdateBranchSchema.safeParse(optionalBody(req));
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const updated = await branchesService.updateProgramBranch({
    programId: writable.program.programId,
    branchId: firstParam(req.params.branchId ?? ""),
    ...parsedBody.data,
  });
  if (!updated.success) {
    respondResearchProgramError(res, updated.error);
    return;
  }
  respondOk(res, "Research branch updated.", updated.value);
}

/** `POST …/branches/:branchId/claim` — idempotent. */
export async function claimBranch(req: Request, res: Response): Promise<void> {
  const writable = await resolveWritableProgram(req, res);
  if (!writable) return;

  const claimed = await branchesService.claimProgramBranch({
    programId: writable.program.programId,
    branchId: firstParam(req.params.branchId ?? ""),
    userId: writable.userId,
  });
  if (!claimed.success) {
    respondResearchProgramError(res, claimed.error);
    return;
  }
  respondOk(res, "You are now working on this branch.", claimed.value);
}

/** `DELETE …/branches/:branchId/claim` — idempotent. */
export async function releaseBranchClaim(req: Request, res: Response): Promise<void> {
  const writable = await resolveWritableProgram(req, res);
  if (!writable) return;

  const released = await branchesService.releaseProgramBranchClaim({
    programId: writable.program.programId,
    branchId: firstParam(req.params.branchId ?? ""),
    userId: writable.userId,
  });
  if (!released.success) {
    respondResearchProgramError(res, released.error);
    return;
  }
  respondOk(res, "You are no longer working on this branch.", released.value);
}

// ---------------------------------------------------------------------------
// Papers
// ---------------------------------------------------------------------------

/** `GET …/papers` — keyset. Non-approved rows are visible only to uploader and staff. */
export async function listPapers(req: Request, res: Response): Promise<void> {
  const program = await resolveVisibleProgram(req, res);
  if (!program) return;

  const parsedQuery = ListPapersQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }
  const decoded = decodeCursorOrRespond(res, parsedQuery.data.cursor);
  if (!decoded.ok) return;

  const viewerUserId = req.user?.id ?? null;
  const isStaff = viewerUserId === null ? false : await hasAnyPlatformRole(viewerUserId);

  const paperPage = await papersService.listProgramPapers({
    programId: program.programId,
    viewerUserId,
    isStaff,
    filter: {
      limit: parsedQuery.data.limit,
      ...(decoded.cursor === undefined ? {} : { cursor: decoded.cursor }),
      ...(parsedQuery.data.categoryId === undefined
        ? {}
        : { categoryId: parsedQuery.data.categoryId }),
      ...(parsedQuery.data.branchId === undefined ? {} : { branchId: parsedQuery.data.branchId }),
      ...(parsedQuery.data.moderationStatus === undefined
        ? {}
        : { moderationStatus: parsedQuery.data.moderationStatus }),
    },
  });

  // Keyset mode DROPS `pagination` rather than faking a total — the same shape every other
  // keyset read in this codebase uses.
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Research papers loaded.",
    data: [...paperPage.rows],
    nextCursor: paperPage.nextCursor,
  });
}

/** `POST …/papers` — the metadata row. The file follows separately. */
export async function createPaper(req: Request, res: Response): Promise<void> {
  const writable = await resolveWritableProgram(req, res);
  if (!writable) return;

  const parsedBody = CreatePaperSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  if (parsedBody.data.branchId !== null) {
    const branch = await branchesService.findBranchInProgram(
      writable.program.programId,
      parsedBody.data.branchId,
    );
    if (!branch) {
      respondResearchProgramError(res, {
        type: "BRANCH_NOT_FOUND",
        branchId: parsedBody.data.branchId,
      });
      return;
    }
  }

  const created = await papersService.createProgramPaper({
    programId: writable.program.programId,
    ...parsedBody.data,
    uploaderUserId: writable.userId,
  });
  if (!created.success) {
    respondResearchProgramError(res, created.error);
    return;
  }

  respondCreated(
    res,
    "Paper record created. Upload the PDF next; a moderator reviews it before it is listed.",
    created.value,
  );
}

/** `POST …/papers/:paperId/file` — multipart. Every file fact is measured, never sent. */
export async function attachPaperFile(req: Request, res: Response): Promise<void> {
  const writable = await resolveWritableProgram(req, res);
  if (!writable) return;

  const parsedBody = AttachPaperFileSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  if (!req.file) {
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "No PDF was attached.",
    } satisfies ApiResponse);
    return;
  }

  const attached = await papersService.attachPaperFile({
    programId: writable.program.programId,
    paperId: firstParam(req.params.paperId ?? ""),
    uploaderUserId: writable.userId,
    pdfBytes: req.file.buffer,
  });
  if (!attached.success) {
    respondResearchProgramError(res, attached.error);
    return;
  }
  respondOk(res, "Paper uploaded. It is queued for review.", attached.value);
}

/**
 * `GET …/papers/:paperId/download` — a short-lived presigned URL.
 *
 * Returns the URL as DATA rather than a 302, so a client parses a value it can reason
 * about (Patterns 2 and 3) instead of following an opaque redirect it cannot inspect.
 */
export async function downloadPaper(req: Request, res: Response): Promise<void> {
  const program = await resolveVisibleProgram(req, res);
  if (!program) return;
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const isStaff = await hasAnyPlatformRole(req.user.id);
  const paperId = firstParam(req.params.paperId ?? "");

  // Visibility is proven on the PAPER, not just the program: a queued paper belonging to
  // somebody else must not be downloadable by anyone who can read the program.
  const paper = await papersService.findProgramPaper({
    programId: program.programId,
    paperId,
    viewerUserId: req.user.id,
    isStaff,
  });
  if (!paper) {
    respondResearchProgramError(res, { type: "PAPER_NOT_FOUND", paperId });
    return;
  }

  const link = await papersService.createPaperDownloadUrl({
    programId: program.programId,
    paperId,
  });
  if (!link.success) {
    respondResearchProgramError(res, link.error);
    return;
  }
  respondOk(res, "Download link created.", link.value);
}

/** `DELETE …/papers/:paperId` — uploader while queued, or staff. */
export async function deletePaper(req: Request, res: Response): Promise<void> {
  const writable = await resolveWritableProgram(req, res);
  if (!writable) return;

  const isStaff = await hasAnyPlatformRole(writable.userId);

  const deleted = await papersService.deleteProgramPaper({
    programId: writable.program.programId,
    paperId: firstParam(req.params.paperId ?? ""),
    actorUserId: writable.userId,
    isStaff,
  });
  if (!deleted.success) {
    respondResearchProgramError(res, deleted.error);
    return;
  }
  respondOk(res, "Paper deleted.", deleted.value);
}

/** `POST …/papers/:paperId/moderate` — the reviewer's verdict. Moderator only. */
export async function moderatePaper(req: Request, res: Response): Promise<void> {
  const staffProgram = await resolveStaffProgram(req, res);
  if (!staffProgram) return;

  const parsedBody = ModeratePaperSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const decided = await moderationService.decidePaperModeration({
    programId: staffProgram.program.programId,
    paperId: firstParam(req.params.paperId ?? ""),
    decision: parsedBody.data.decision,
    reviewerNote: parsedBody.data.reviewerNote,
    flagReasons: parsedBody.data.flagReasons,
    staff: staffProgram.staff,
  });
  if (!decided.success) {
    respondResearchProgramError(res, decided.error);
    return;
  }
  respondOk(res, `Paper ${parsedBody.data.decision}.`, decided.value);
}

/** `GET …/moderation/queue` — open reports, oldest first. Moderator only. */
export async function listModerationQueue(req: Request, res: Response): Promise<void> {
  const staffProgram = await resolveStaffProgram(req, res);
  if (!staffProgram) return;

  const parsedQuery = CursorQuerySchema.strict().safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }
  const decoded = decodeCursorOrRespond(res, parsedQuery.data.cursor);
  if (!decoded.ok) return;

  const [reportPage, queuedPaperCount] = await Promise.all([
    moderationService.listOpenContentReports({
      programId: staffProgram.program.programId,
      limit: parsedQuery.data.limit,
      ...(decoded.cursor === undefined ? {} : { cursor: decoded.cursor }),
    }),
    papersService.countProgramPapersByStatus(staffProgram.program.programId, ["queued"]),
  ]);

  /**
   * The cursor and the paper count live INSIDE `data`, not beside it.
   *
   * Every other keyset read in this codebase puts the array in `data` and `nextCursor`
   * alongside it — but those return ONE list and nothing else. This route returns a list plus
   * a scalar the queue badges, and a client helper that reads `data` cannot see a third
   * sibling. Putting all three in `data` keeps the payload readable by an ordinary
   * `getJson`-shaped client instead of needing a bespoke transport path for one screen.
   */
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Moderation queue loaded.",
    data: {
      reports: [...reportPage.rows],
      nextCursor: reportPage.nextCursor,
      // So the queue can badge "12 papers awaiting review" without a second round trip.
      queuedPaperCount,
    },
  } satisfies ApiResponse);
}

/** `GET …/moderation/actions` — this program's decision log. Moderator only. */
export async function listModerationActions(req: Request, res: Response): Promise<void> {
  const staffProgram = await resolveStaffProgram(req, res);
  if (!staffProgram) return;

  const actions = await moderationService.listProgramModerationActions({
    programId: staffProgram.program.programId,
    limit: 100,
  });
  respondOk(res, "Moderation actions loaded.", actions);
}

// ---------------------------------------------------------------------------
// Paper categories (root-mounted)
// ---------------------------------------------------------------------------

/** `GET /research-paper-categories` — approved by default. Public. */
export async function listPaperCategories(req: Request, res: Response): Promise<void> {
  const parsedQuery = ListPaperCategoriesQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }
  const categories = await categoriesService.listResearchPaperCategories(parsedQuery.data.status);
  respondOk(res, "Paper categories loaded.", categories);
}

/** `POST /research-paper-categories` — lands `pending`. */
export async function createPaperCategory(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const parsedBody = CreatePaperCategorySchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const created = await categoriesService.createResearchPaperCategory(
    parsedBody.data.label,
    req.user.id,
  );
  if (!created.success) {
    respondResearchProgramError(res, created.error);
    return;
  }
  respondCreated(res, "Paper category submitted for review.", created.value);
}

/**
 * `POST /research-paper-categories/:categoryId/decide` — `moderate_taxonomy`.
 *
 * The capability is checked inside the service, not by middleware, and before the id is read.
 * Middleware cannot return a `Result`, so it could not take part in the exhaustive error switch
 * that maps every domain error to its status — which is where an authorization decision belongs.
 */
export async function decidePaperCategory(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const parsedBody = DecidePaperCategorySchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const decided = await categoriesService.decidePaperCategory(
    req.user.id,
    firstParam(req.params.categoryId ?? ""),
    parsedBody.data,
  );
  if (!decided.success) {
    respondResearchProgramError(res, decided.error);
    return;
  }
  respondOk(res, "Paper category decision recorded.", decided.value);
}

// ---------------------------------------------------------------------------
// Posts, reactions, reports
// ---------------------------------------------------------------------------

/** `GET …/posts` — a track's feed, keyset, with up to three inline replies per post. */
export async function listPosts(req: Request, res: Response): Promise<void> {
  const program = await resolveVisibleProgram(req, res);
  if (!program) return;

  const parsedQuery = ListPostsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }
  const decoded = decodeCursorOrRespond(res, parsedQuery.data.cursor);
  if (!decoded.ok) return;

  const postPage = await postsService.listProgramPosts({
    programId: program.programId,
    viewerUserId: req.user?.id ?? null,
    filter: {
      track: parsedQuery.data.track,
      limit: parsedQuery.data.limit,
      ...(decoded.cursor === undefined ? {} : { cursor: decoded.cursor }),
    },
  });

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Posts loaded.",
    data: [...postPage.rows],
    nextCursor: postPage.nextCursor,
  });
}

/** `GET …/posts/:postId/replies` — the full thread, oldest first, keyset. */
export async function listReplies(req: Request, res: Response): Promise<void> {
  const program = await resolveVisibleProgram(req, res);
  if (!program) return;

  const parsedQuery = CursorQuerySchema.strict().safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }
  const decoded = decodeCursorOrRespond(res, parsedQuery.data.cursor);
  if (!decoded.ok) return;

  const replyPage = await postsService.listPostReplies({
    programId: program.programId,
    parentPostId: firstParam(req.params.postId ?? ""),
    viewerUserId: req.user?.id ?? null,
    limit: parsedQuery.data.limit,
    ...(decoded.cursor === undefined ? {} : { cursor: decoded.cursor }),
  });
  if (!replyPage.success) {
    respondResearchProgramError(res, replyPage.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Replies loaded.",
    data: [...replyPage.value.rows],
    nextCursor: replyPage.value.nextCursor,
  });
}

/** `POST …/posts` — an informal paper or an idea. */
export async function createPost(req: Request, res: Response): Promise<void> {
  const writable = await resolveWritableProgram(req, res);
  if (!writable) return;

  const parsedBody = CreatePostSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  // The branch must belong to THIS program, or a thread could be filed against another
  // program's tree — which the per-branch discussion count would then report.
  if (parsedBody.data.branchId !== null) {
    const branch = await branchesService.findBranchInProgram(
      writable.program.programId,
      parsedBody.data.branchId,
    );
    if (!branch) {
      respondResearchProgramError(res, {
        type: "BRANCH_NOT_FOUND",
        branchId: parsedBody.data.branchId,
      });
      return;
    }
  }

  const created = await postsService.createProgramPost({
    programId: writable.program.programId,
    track: parsedBody.data.track,
    title: parsedBody.data.title,
    bodyText: parsedBody.data.bodyText,
    branchId: parsedBody.data.branchId,
    authorUserId: writable.userId,
  });
  if (!created.success) {
    respondResearchProgramError(res, created.error);
    return;
  }
  respondCreated(res, "Posted.", created.value);
}

/** `POST …/posts/:postId/replies` — one level deep. */
export async function createReply(req: Request, res: Response): Promise<void> {
  const writable = await resolveWritableProgram(req, res);
  if (!writable) return;

  const parsedBody = CreateReplySchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const created = await postsService.createPostReply({
    programId: writable.program.programId,
    parentPostId: firstParam(req.params.postId ?? ""),
    bodyText: parsedBody.data.bodyText,
    authorUserId: writable.userId,
  });
  if (!created.success) {
    respondResearchProgramError(res, created.error);
    return;
  }
  respondCreated(res, "Reply posted.", created.value);
}

/**
 * `PUT …/posts/:postId/reaction` — idempotent by verb (§10).
 *
 * `PUT`, not `POST`, precisely so a double-tap on a slow connection is harmless. Returns the
 * server's count so the client renders a number it was given rather than one it guessed.
 */
export async function addReaction(req: Request, res: Response): Promise<void> {
  const writable = await resolveWritableProgram(req, res);
  if (!writable) return;

  const reacted = await postsService.addPostReaction({
    programId: writable.program.programId,
    postId: firstParam(req.params.postId ?? ""),
    userId: writable.userId,
  });
  if (!reacted.success) {
    respondResearchProgramError(res, reacted.error);
    return;
  }
  respondOk(res, "Reaction recorded.", reacted.value);
}

/** `DELETE …/posts/:postId/reaction` — idempotent in the same way. */
export async function removeReaction(req: Request, res: Response): Promise<void> {
  const writable = await resolveWritableProgram(req, res);
  if (!writable) return;

  const removed = await postsService.removePostReaction({
    programId: writable.program.programId,
    postId: firstParam(req.params.postId ?? ""),
    userId: writable.userId,
  });
  if (!removed.success) {
    respondResearchProgramError(res, removed.error);
    return;
  }
  respondOk(res, "Reaction removed.", removed.value);
}

/** `POST …/posts/:postId/report` — one report per user per target. */
export async function reportPost(req: Request, res: Response): Promise<void> {
  const writable = await resolveWritableProgram(req, res);
  if (!writable) return;

  const parsedBody = ReportContentSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const postId = firstParam(req.params.postId ?? "");
  const post = await postsService.findPostInProgram(writable.program.programId, postId);
  if (!post) {
    respondResearchProgramError(res, { type: "POST_NOT_FOUND", postId });
    return;
  }

  const reported = await postsService.reportProgramContent({
    programId: writable.program.programId,
    targetKind: "post",
    paperId: null,
    postId,
    reason: parsedBody.data.reason,
    detailText: parsedBody.data.detailText,
    reporterUserId: writable.userId,
  });
  if (!reported.success) {
    respondResearchProgramError(res, reported.error);
    return;
  }
  respondCreated(res, "Reported. A moderator will review it.", reported.value);
}

/** `POST …/papers/:paperId/report` — the paper half of the same primitive. */
export async function reportPaper(req: Request, res: Response): Promise<void> {
  const writable = await resolveWritableProgram(req, res);
  if (!writable) return;

  const parsedBody = ReportContentSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const paperId = firstParam(req.params.paperId ?? "");
  const isStaff = await hasAnyPlatformRole(writable.userId);
  const paper = await papersService.findProgramPaper({
    programId: writable.program.programId,
    paperId,
    viewerUserId: writable.userId,
    isStaff,
  });
  if (!paper) {
    respondResearchProgramError(res, { type: "PAPER_NOT_FOUND", paperId });
    return;
  }

  const reported = await postsService.reportProgramContent({
    programId: writable.program.programId,
    targetKind: "paper",
    paperId,
    postId: null,
    reason: parsedBody.data.reason,
    detailText: parsedBody.data.detailText,
    reporterUserId: writable.userId,
  });
  if (!reported.success) {
    respondResearchProgramError(res, reported.error);
    return;
  }
  respondCreated(res, "Reported. A moderator will review it.", reported.value);
}

/** `POST …/posts/:postId/moderate` — hide or restore. Moderator only, and reversible. */
export async function moderatePost(req: Request, res: Response): Promise<void> {
  const staffProgram = await resolveStaffProgram(req, res);
  if (!staffProgram) return;

  const parsedBody = ModeratePostSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const decided = await moderationService.decidePostVisibility({
    programId: staffProgram.program.programId,
    postId: firstParam(req.params.postId ?? ""),
    decision: parsedBody.data.decision,
    reasonNote: parsedBody.data.reasonNote,
    staff: staffProgram.staff,
  });
  if (!decided.success) {
    respondResearchProgramError(res, decided.error);
    return;
  }
  respondOk(
    res,
    parsedBody.data.decision === "hidden" ? "Post hidden." : "Post restored.",
    decided.value,
  );
}

/** `POST …/reports/:reportId/dismiss` — "we looked, this is fine". Recorded either way. */
export async function dismissReport(req: Request, res: Response): Promise<void> {
  const staffProgram = await resolveStaffProgram(req, res);
  if (!staffProgram) return;

  const parsedBody = DismissReportSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const dismissed = await moderationService.dismissContentReport({
    programId: staffProgram.program.programId,
    reportId: firstParam(req.params.reportId ?? ""),
    reasonNote: parsedBody.data.reasonNote,
    staff: staffProgram.staff,
  });
  if (!dismissed.success) {
    respondResearchProgramError(res, dismissed.error);
    return;
  }
  respondOk(res, "Report dismissed.", dismissed.value);
}

// ---------------------------------------------------------------------------
// Participants, effort, contributions
// ---------------------------------------------------------------------------

/** `GET …/contributors` — the roster, filtered by role IN SQL. */
export async function listContributors(req: Request, res: Response): Promise<void> {
  const program = await resolveVisibleProgram(req, res);
  if (!program) return;

  const parsedQuery = ListParticipantsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }
  const { page, limit, role } = parsedQuery.data;

  const rosterPage = await participantsService.listProgramParticipants({
    programId: program.programId,
    viewerUserId: req.user?.id ?? null,
    ...(role === undefined ? {} : { role }),
    limit,
    offset: (page - 1) * limit,
  });

  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message: "Contributors loaded.",
    data: [...rosterPage.rows],
    pagination: {
      page,
      limit,
      total: rosterPage.total,
      totalPages: Math.ceil(rosterPage.total / limit),
    },
  };
  res.status(200).json(response);
}

/** `POST …/contributors/me` — joins. */
export async function joinProgram(req: Request, res: Response): Promise<void> {
  const writable = await resolveWritableProgram(req, res);
  if (!writable) return;

  const parsedBody = JoinProgramSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const joined = await participantsService.joinResearchProgram({
    programId: writable.program.programId,
    userId: writable.userId,
    ...parsedBody.data,
  });
  if (!joined.success) {
    respondResearchProgramError(res, joined.error);
    return;
  }
  respondCreated(res, "You are now a contributor to this program.", joined.value);
}

/** `PATCH …/contributors/me` — edits your own participation. Nobody else's. */
export async function updateOwnParticipation(req: Request, res: Response): Promise<void> {
  const writable = await resolveWritableProgram(req, res);
  if (!writable) return;

  const parsedBody = UpdateParticipationSchema.safeParse(optionalBody(req));
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const updated = await participantsService.updateOwnParticipation({
    programId: writable.program.programId,
    userId: writable.userId,
    ...parsedBody.data,
  });
  if (!updated.success) {
    respondResearchProgramError(res, updated.error);
    return;
  }
  respondOk(res, "Your contribution details were updated.", updated.value);
}

/** `POST …/effort-logs` — self-reported time. Not equity, not verified. */
export async function logEffort(req: Request, res: Response): Promise<void> {
  const writable = await resolveWritableProgram(req, res);
  if (!writable) return;

  const parsedBody = LogEffortSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const participant = await findParticipant(writable.program.programId, writable.userId);
  if (!participant) {
    respondResearchProgramError(res, { type: "NOT_A_PARTICIPANT" });
    return;
  }

  if (parsedBody.data.branchId !== null) {
    const branch = await branchesService.findBranchInProgram(
      writable.program.programId,
      parsedBody.data.branchId,
    );
    if (!branch) {
      respondResearchProgramError(res, {
        type: "BRANCH_NOT_FOUND",
        branchId: parsedBody.data.branchId,
      });
      return;
    }
  }

  const logged = await participantsService.logResearchEffort({
    programId: writable.program.programId,
    participantId: participant.participantId,
    ...parsedBody.data,
  });
  if (!logged.success) {
    respondResearchProgramError(res, logged.error);
    return;
  }

  // A replay is a 200, not a 201: nothing was created this time, and telling a client it
  // created a second log would be a lie it might act on.
  const statusCode = logged.value.wasReplay ? 200 : 201;
  res.status(statusCode).json({
    status: "success",
    statusCode,
    message: logged.value.wasReplay
      ? "This effort log was already recorded."
      : "Effort logged. It is self-reported and does not affect equity.",
    data: logged.value,
  } satisfies ApiResponse);
}

/** `POST …/contributions` — a RECORD OF INTENT. No money moves. */
export async function recordContribution(req: Request, res: Response): Promise<void> {
  const writable = await resolveWritableProgram(req, res);
  if (!writable) return;

  const parsedBody = RecordContributionSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const participant = await findParticipant(writable.program.programId, writable.userId);
  if (!participant) {
    respondResearchProgramError(res, { type: "NOT_A_PARTICIPANT" });
    return;
  }

  const recorded = await participantsService.recordResearchContribution({
    programId: writable.program.programId,
    participantId: participant.participantId,
    kind: parsedBody.data.kind,
    // The decimal string becomes a number at the boundary, once, here.
    amountInCents:
      parsedBody.data.amountInCents === null ? null : Number(parsedBody.data.amountInCents),
    currencyCode: parsedBody.data.currencyCode,
    description: parsedBody.data.description,
    idempotencyKey: parsedBody.data.idempotencyKey,
  });
  if (!recorded.success) {
    respondResearchProgramError(res, recorded.error);
    return;
  }

  const statusCode = recorded.value.wasReplay ? 200 : 201;
  res.status(statusCode).json({
    status: "success",
    statusCode,
    message: recorded.value.wasReplay
      ? "This contribution was already recorded."
      : // Says out loud that nothing was collected. §7's ruling on pledges, applied here.
        "Contribution recorded as a commitment. No payment has been collected.",
    data: recorded.value,
  } satisfies ApiResponse);
}

// ---------------------------------------------------------------------------
// Product opportunities
// ---------------------------------------------------------------------------

/** `GET …/product-opportunities` — public, largest projection first. */
export async function listOpportunities(req: Request, res: Response): Promise<void> {
  const program = await resolveVisibleProgram(req, res);
  if (!program) return;

  const opportunities = await opportunitiesService.listProgramOpportunities(program.programId);
  respondOk(res, "Product opportunities loaded.", opportunities);
}

/**
 * `POST …/product-opportunities` — CREATOR OR STAFF, not any contributor.
 *
 * Unlike branches, papers and posts, this is a claim the program makes about what its
 * research could be worth. Every contributor being able to publish one turns the rail into
 * an advertising surface.
 */
export async function createOpportunity(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const programSlug = firstParam(req.params.programSlug ?? "");
  const isStaff = await hasAnyPlatformRole(req.user.id);

  const visible = await requireProgramVisible(programSlug, req.user.id, isStaff);
  if (!visible.success) {
    respondResearchProgramError(res, visible.error);
    return;
  }
  if (!visible.value.isCreator && !isStaff) {
    // 404, not 403: this is a WRITE-ownership failure on a resource whose existence the
    // caller may legitimately know, but naming the distinction here would tell a stranger
    // that "this program exists and you are simply not its owner" — which is the probe the
    // 404-never-403 rule closes.
    respondResearchProgramError(res, { type: "NOT_FOUND", programRef: programSlug });
    return;
  }
  if (visible.value.programStatus !== "published") {
    respondResearchProgramError(res, {
      type: "PROGRAM_NOT_PUBLISHED",
      status: visible.value.programStatus,
    });
    return;
  }

  const parsedBody = CreateOpportunitySchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const created = await opportunitiesService.createProgramOpportunity({
    programId: visible.value.programId,
    productName: parsedBody.data.productName,
    productDescription: parsedBody.data.productDescription,
    derivedFromBranchId: parsedBody.data.derivedFromBranchId,
    estimatedMarketSizeInCents: Number(parsedBody.data.estimatedMarketSizeInCents),
    readinessMinMonths: parsedBody.data.readinessMinMonths,
    readinessMaxMonths: parsedBody.data.readinessMaxMonths,
    createdByUserId: req.user.id,
  });
  if (!created.success) {
    respondResearchProgramError(res, created.error);
    return;
  }
  respondCreated(res, "Product opportunity added.", created.value);
}

/** `DELETE …/product-opportunities/:opportunityId` — creator or staff. */
export async function deleteOpportunity(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const programSlug = firstParam(req.params.programSlug ?? "");
  const isStaff = await hasAnyPlatformRole(req.user.id);

  const visible = await requireProgramVisible(programSlug, req.user.id, isStaff);
  if (!visible.success) {
    respondResearchProgramError(res, visible.error);
    return;
  }
  if (!visible.value.isCreator && !isStaff) {
    respondResearchProgramError(res, { type: "NOT_FOUND", programRef: programSlug });
    return;
  }

  const deleted = await opportunitiesService.deleteProgramOpportunity({
    programId: visible.value.programId,
    opportunityId: firstParam(req.params.opportunityId ?? ""),
  });
  if (!deleted.success) {
    respondResearchProgramError(res, deleted.error);
    return;
  }
  respondOk(res, "Product opportunity removed.", deleted.value);
}
