import type { Request, Response } from "express";

import {
  firstParam,
  optionalBody,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/project-error-response.js";
import { respondResearchProgramError } from "#src/controllers/research-program-error-response.js";
import { decodeInstantCursor, type InstantCursor } from "#src/lib/instant-cursor.js";
import {
  AttachPaperFileSchema,
  CreateBranchSchema,
  CreateOpportunitySchema,
  CreatePaperCategorySchema,
  CreatePaperSchema,
  CreatePostSchema,
  CreateProgramSchema,
  CreateReplySchema,
  CursorQuerySchema,
  DecidePaperCategorySchema,
  DismissReportSchema,
  JoinProgramSchema,
  ListPaperCategoriesQuerySchema,
  ListPapersQuerySchema,
  ListParticipantsQuerySchema,
  ListPostsQuerySchema,
  ListProgramsQuerySchema,
  LogEffortSchema,
  ModeratePaperSchema,
  ModeratePostSchema,
  ModerateProgramSchema,
  PageQuerySchema,
  RecordContributionSchema,
  ReportContentSchema,
  UpdateBranchSchema,
  UpdateParticipationSchema,
  UpdateProgramSchema,
} from "#src/schemas/research-programs.schemas.js";
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
