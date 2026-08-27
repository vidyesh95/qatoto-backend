/**
 * §12 pitch lifecycle: create a draft, edit it, submit it for review, close it, read it.
 *
 * The moderator's half lives in `pitch-moderation.service.ts` and the outcome ledger in
 * `pitch-outcomes.service.ts`, for the same reason the programs module splits them: a file
 * that both proposes and approves invites a caller to do one while meaning the other.
 *
 * NOTHING HERE MOVES MONEY, and nothing here can be made to. A pitch stores two URLs
 * pointing somewhere else. If a future edit to this file introduces an amount, a pledge or
 * a payment provider, the §12 header in `src/db/schema/rnd.ts` is the argument against it.
 */

import { and, desc, eq, isNotNull, lte, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { pitch, researchProject, video } from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { normalizePitchLinks } from "#src/modules/rnd/pitches/pitch-link.js";
import type { PitchLinkError } from "#src/modules/rnd/pitches/pitch-link.js";
import type {
  CreatePitchInput,
  UpdatePitchInput,
} from "#src/modules/rnd/pitches/pitches.schemas.js";
import { PUBLICLY_SERVABLE } from "#src/modules/studio/public-video-gate.js";
import type { Result } from "#src/types/index.js";

export type PitchStatus = (typeof pitch.$inferSelect)["status"];

export type PitchError =
  | { type: "PITCH_NOT_FOUND" }
  | { type: "PROJECT_NOT_FOUND" }
  /** The caller is not the project's founder. Rendered as a 404 — see the error mapper. */
  | { type: "NOT_THE_FOUNDER" }
  | { type: "PITCH_TITLE_UNUSABLE" }
  /** Editing or submitting something already decided. */
  | { type: "PITCH_NOT_EDITABLE"; status: PitchStatus }
  | { type: "PITCH_NOT_SUBMITTABLE"; status: PitchStatus }
  | { type: "PITCH_NOT_CLOSEABLE"; status: PitchStatus }
  | { type: "PITCH_NOT_DELETABLE"; status: PitchStatus }
  /** A draft project is invisible to everyone but its founder. */
  | { type: "PROJECT_NOT_PUBLIC"; status: string }
  /** A pitch with nowhere to send anyone is not a pitch. */
  | { type: "PITCH_INCOMPLETE"; missingField: string }
  /**
   * The chosen video is not one this pitch may embed. FOUR DISTINCT CAUSES, ONE ANSWER —
   * no such video, not public, not this venture's, or someone else's entirely — because
   * distinguishing them would turn this field into an oracle for video ids.
   */
  | { type: "PITCH_VIDEO_NOT_ELIGIBLE" }
  | PitchLinkError;

/**
 * The wire shape. Money never appears on it because none exists on this table.
 *
 * `externalFundingUrl` and `externalContactUrl` are the NORMALIZED values — what the parser
 * stored, not what was typed — so two clients rendering the same pitch render the same link.
 */
/**
 * The video a pitch embeds, as the public may see it.
 *
 * EVERY FIELD HERE IS ALREADY PUBLIC on `WatchPayload` and the feed item, so this projection
 * exposes nothing new. What is DELIBERATELY ABSENT is the lifecycle set — `visibility`,
 * `publishStatus`, `reviewStatus`, `uploadStatus`, `isSourceVerified` — which
 * `video-watch.service.ts` calls "lifecycle facts the public has no claim on, and several of
 * them are exactly what the 404-not-403 policy exists to hide".
 */
export interface PitchVideoView {
  readonly videoId: string;
  readonly videoSource: (typeof video.$inferSelect)["videoSource"];
  readonly youtubeVideoId: string | null;
  readonly title: string;
  readonly thumbnailUrl: string | null;
  /** NULL until the duration job has enough samples. An absence, never a zero. */
  readonly durationSeconds: number | null;
}

export interface PitchView {
  readonly id: string;
  readonly slug: string;
  readonly projectId: string;
  readonly projectSlug: string;
  readonly projectName: string;
  readonly title: string;
  readonly summary: string;
  /**
   * THE WRITE TAKES AN ID AND THE READ RETURNS AN OBJECT, deliberately. A client can only
   * name a video it already has; everything else about it is the server's to say.
   *
   * NULL means "no video, or the video is no longer publicly servable" — the two are one
   * answer on purpose. The join that fills this applies the public gate in its ON clause, so
   * a video taken down after the pitch was published nulls this field rather than 404ing a
   * live funding solicitation.
   */
  readonly pitchVideo: PitchVideoView | null;
  readonly externalFundingUrl: string | null;
  readonly externalContactUrl: string | null;
  readonly status: PitchStatus;
  /** Present only on a rejection, and shown to the submitter. */
  readonly rejectionReason: string | null;
  readonly publishedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

type PitchRow = typeof pitch.$inferSelect;

/**
 * The columns every pitch read selects for its embedded video.
 *
 * Declared once so the four reads cannot drift into projecting different fields — the drift
 * that would matter is one of them leaking a lifecycle column.
 */
const PITCH_VIDEO_COLUMNS = {
  videoId: video.id,
  videoSource: video.videoSource,
  youtubeVideoId: video.youtubeVideoId,
  videoTitle: video.title,
  thumbnailUrl: video.thumbnailUrl,
  durationSeconds: video.durationSeconds,
} as const;

/**
 * The ON clause for joining a pitch to its video.
 *
 * ⚠️ THE GATE LIVES IN THE JOIN, NOT THE WHERE, and the difference is the whole design.
 * In a WHERE it would filter the PITCH out whenever its video stopped being public — a live
 * funding solicitation vanishing because a moderator hid a video. Here it only nulls the
 * video columns, which is the intended answer: the pitch renders, the player does not.
 *
 * This is `video-watch.service.ts`'s choice for its venture badge, and the OPPOSITE of
 * `spotlight.service.ts`, which inner-joins so an ineligible slot drops out of the rail
 * entirely. Both are right: there the row IS the video, here it is not.
 */
const PITCH_VIDEO_JOIN = and(
  eq(video.id, pitch.pitchVideoId),
  PUBLICLY_SERVABLE,
  lte(video.publishedAt, sql`now()`),
);

/** The joined video columns as they come back — all null when the join found nothing. */
interface JoinedPitchVideo {
  readonly videoId: string | null;
  readonly videoSource: (typeof video.$inferSelect)["videoSource"] | null;
  readonly youtubeVideoId: string | null;
  readonly videoTitle: string | null;
  readonly thumbnailUrl: string | null;
  readonly durationSeconds: number | null;
}

function toPitchVideoView(joined: JoinedPitchVideo | undefined): PitchVideoView | null {
  if (!joined || joined.videoId === null || joined.videoSource === null) return null;
  return {
    videoId: joined.videoId,
    videoSource: joined.videoSource,
    youtubeVideoId: joined.youtubeVideoId,
    // `title` is NOT NULL on the column; the null here is the LEFT JOIN's, not the data's.
    title: joined.videoTitle ?? "",
    thumbnailUrl: joined.thumbnailUrl,
    durationSeconds: joined.durationSeconds,
  };
}

function toPitchView(
  row: PitchRow,
  project: { readonly slug: string; readonly name: string },
  joinedVideo?: JoinedPitchVideo,
): PitchView {
  return {
    id: row.id,
    slug: row.slug,
    projectId: row.projectId,
    projectSlug: project.slug,
    projectName: project.name,
    title: row.title,
    summary: row.summary,
    pitchVideo: toPitchVideoView(joinedVideo),
    externalFundingUrl: row.externalFundingUrl,
    externalContactUrl: row.externalContactUrl,
    status: row.status,
    rejectionReason: row.rejectionReason,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Server-derives a slug from a title.
 *
 * AUTO-SUFFIXES ON COLLISION (`-2`, `-3`), matching `research_project.slug` and
 * `research_program.slug`. Two ventures may legitimately pitch under similar names.
 */
export function slugifyPitchTitle(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70)
    .replace(/-+$/g, "");
}

/**
 * Re-reads one pitch through the video join, by id.
 *
 * ⚠️ EVERY WRITE RETURNS THIS, NOT ITS OWN `.returning()` ROW. Found by the live run: an
 * update's `returning()` gives back the pitch columns and nothing else, so `pitchVideo` came
 * out NULL on the very response that had just attached a video. The row was right and the
 * answer was wrong — the worst shape of bug, because the client caches the lie.
 *
 * The joined read is the only place that knows whether the video is publicly servable, so it
 * is the only thing entitled to answer the question.
 */
async function readPitchViewById(pitchId: string): Promise<PitchView | null> {
  const [found] = await db
    .select({
      row: pitch,
      projectSlug: researchProject.slug,
      projectName: researchProject.name,
      ...PITCH_VIDEO_COLUMNS,
    })
    .from(pitch)
    .innerJoin(researchProject, eq(researchProject.id, pitch.projectId))
    .leftJoin(video, PITCH_VIDEO_JOIN)
    .where(eq(pitch.id, pitchId));

  if (!found) return null;
  return toPitchView(found.row, { slug: found.projectSlug, name: found.projectName }, found);
}

/**
 * Proves a video may be embedded by a pitch on this venture.
 *
 * ⚠️ THIS FUNCTION IS THE SECURITY BOUNDARY ON `pitch.pitch_video_id`, and it did not exist
 * when the column shipped. The foreign key proves only that A VIDEO ROW EXISTS — not that the
 * founder owns it, not that it is public, not that it has anything to do with this venture. A
 * pitch could therefore name any video id in the system, and the moment the public pitch page
 * renders a title and thumbnail, a stranger's private upload leaks. `studio.ts` warned about
 * exactly this for `attached_pitch_id` ("accepting it today would store an unvalidated client
 * string"); this is the check that stops the replacement column repeating it.
 *
 * TWO CONDITIONS, AND THE SECOND IS WHAT MAKES OWNERSHIP CHECKABLE WITHOUT A SECOND GATE:
 *
 *  1. The video passes `PUBLICLY_SERVABLE` — imported rather than re-typed, because three
 *     byte-identical copies of that predicate already exist and a fourth that drifts would
 *     serve hidden content with nothing failing to tell you. Plus `published_at <= now()`,
 *     which every caller applies separately so a scheduled row is not readable early.
 *  2. `video.research_project_id` is THIS pitch's project. Attaching a video to a venture
 *     already went through `resolveAttachableResearchProjectId`, which proved active
 *     membership of an active project. A video that names this venture has passed that gate,
 *     so this one does not have to re-derive it.
 *
 * FOUR FAILURES, ONE ANSWER. No such video, not public, not this venture's, and not yours are
 * indistinguishable to the caller — otherwise the field becomes an oracle for video ids.
 */
async function isVideoEmbeddableByPitch(projectId: string, videoId: string): Promise<boolean> {
  const [eligible] = await db
    .select({ id: video.id })
    .from(video)
    .where(
      and(
        eq(video.id, videoId),
        eq(video.researchProjectId, projectId),
        PUBLICLY_SERVABLE,
        lte(video.publishedAt, sql`now()`),
      ),
    )
    .limit(1);
  return eligible !== undefined;
}

/**
 * Loads a pitch and proves the caller founds the project it belongs to.
 *
 * ONE QUERY, not two, so there is no window in which the pitch is read and the ownership
 * check reads a different row. Returns `PITCH_NOT_FOUND` for a stranger and
 * `NOT_THE_FOUNDER` for a signed-in non-founder; both become a 404, and the distinction
 * exists for the log rather than for the response.
 */
export async function findOwnedPitch(
  pitchId: string,
  callerUserId: string,
): Promise<Result<{ readonly row: PitchRow; readonly view: PitchView }, PitchError>> {
  const [found] = await db
    .select({
      row: pitch,
      projectSlug: researchProject.slug,
      projectName: researchProject.name,
      founderUserId: researchProject.founderUserId,
      ...PITCH_VIDEO_COLUMNS,
    })
    .from(pitch)
    .innerJoin(researchProject, eq(researchProject.id, pitch.projectId))
    .leftJoin(video, PITCH_VIDEO_JOIN)
    .where(eq(pitch.id, pitchId));

  if (!found) return { success: false, error: { type: "PITCH_NOT_FOUND" } };
  if (found.founderUserId !== callerUserId) {
    return { success: false, error: { type: "NOT_THE_FOUNDER" } };
  }
  return {
    success: true,
    value: {
      row: found.row,
      view: toPitchView(found.row, { slug: found.projectSlug, name: found.projectName }, found),
    },
  };
}

/**
 * Creates a draft pitch on a project the caller founds.
 *
 * A DRAFT IS INVISIBLE AND THAT IS THE POINT — creating is not publishing, and it is not
 * even submitting. Two further acts stand between this row and a stranger seeing it, which
 * is the same shape `service-offering-composer` and the programme wizard already follow.
 */
export async function createPitch(
  projectSlug: string,
  founderUserId: string,
  input: CreatePitchInput,
): Promise<Result<PitchView, PitchError>> {
  const [project] = await db
    .select({
      id: researchProject.id,
      slug: researchProject.slug,
      name: researchProject.name,
      founderUserId: researchProject.founderUserId,
    })
    .from(researchProject)
    .where(eq(researchProject.slug, projectSlug));

  if (!project) return { success: false, error: { type: "PROJECT_NOT_FOUND" } };
  // A non-founder is told the project does not exist, not that it is not theirs.
  if (project.founderUserId !== founderUserId) {
    return { success: false, error: { type: "NOT_THE_FOUNDER" } };
  }

  const links = normalizePitchLinks({
    externalFundingUrl: input.externalFundingUrl,
    externalContactUrl: input.externalContactUrl,
  });
  if (!links.success) return links;

  // REFUSED UP FRONT rather than stored and silently dropped from the public read — the rule
  // `spotlight.service.ts` states for its own video slots.
  if (
    input.pitchVideoId !== undefined &&
    !(await isVideoEmbeddableByPitch(project.id, input.pitchVideoId))
  ) {
    return { success: false, error: { type: "PITCH_VIDEO_NOT_ELIGIBLE" } };
  }

  const baseSlug = slugifyPitchTitle(input.title);
  if (baseSlug.length < 3) {
    // A title of pure punctuation or emoji cannot produce a usable public URL.
    return { success: false, error: { type: "PITCH_TITLE_UNUSABLE" } };
  }

  // The slug race is resolved by LETTING THE INSERT TRY and translating 23505, never by
  // check-then-insert — that is a TOCTOU race, and `isUniqueViolation` exists precisely so
  // uniqueness is decided by the database.
  const MAX_SLUG_ATTEMPTS = 12;
  for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt += 1) {
    const candidateSlug = attempt === 1 ? baseSlug : `${baseSlug}-${String(attempt)}`;
    try {
      const [created] = await db
        .insert(pitch)
        .values({
          slug: candidateSlug,
          projectId: project.id,
          title: input.title,
          summary: input.summary,
          pitchVideoId: input.pitchVideoId ?? null,
          externalFundingUrl: links.value.externalFundingUrl,
          externalContactUrl: links.value.externalContactUrl,
          // Explicit rather than relying on the column default, so reading this call
          // answers "what state does a new pitch start in" without opening schema.ts.
          status: "draft",
        })
        .returning();
      if (!created) throw new Error("createPitch: insert returned no row");
      const createdView = await readPitchViewById(created.id);
      if (!createdView) throw new Error("createPitch: re-read found no row");
      return { success: true, value: createdView };
    } catch (insertError: unknown) {
      if (!isUniqueViolation(insertError)) throw insertError;
      // Slug taken — the next attempt appends a higher suffix.
    }
  }
  return { success: false, error: { type: "PITCH_TITLE_UNUSABLE" } };
}

/**
 * Edits a pitch.
 *
 * EDITABLE WHILE `draft` OR `rejected`, and nothing else. A `pending` pitch is in front of
 * a moderator and editing it under them would mean they approved text nobody else saw; a
 * `published` one has been linked to. A rejected pitch is editable precisely so the reason
 * can be acted on — that is the whole point of showing it.
 *
 * The slug does NOT follow the title. Once minted it is an address.
 */
export async function updatePitch(
  pitchId: string,
  callerUserId: string,
  input: UpdatePitchInput,
): Promise<Result<PitchView, PitchError>> {
  const owned = await findOwnedPitch(pitchId, callerUserId);
  if (!owned.success) return owned;

  const current = owned.value.row;
  if (current.status !== "draft" && current.status !== "rejected") {
    return { success: false, error: { type: "PITCH_NOT_EDITABLE", status: current.status } };
  }

  // `null` clears the video and needs no gate; a non-null value is re-checked on every edit,
  // because a video that was eligible when the draft was written may not be now.
  if (
    input.pitchVideoId !== undefined &&
    input.pitchVideoId !== null &&
    !(await isVideoEmbeddableByPitch(current.projectId, input.pitchVideoId))
  ) {
    return { success: false, error: { type: "PITCH_VIDEO_NOT_ELIGIBLE" } };
  }

  const links = normalizePitchLinks({
    externalFundingUrl: input.externalFundingUrl,
    externalContactUrl: input.externalContactUrl,
  });
  if (!links.success) return links;

  const [updated] = await db
    .update(pitch)
    .set({
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      ...(input.pitchVideoId === undefined ? {} : { pitchVideoId: input.pitchVideoId }),
      // `undefined` means "not mentioned"; `null` means "clear it". The normalizer preserves
      // that distinction, which is why these read from its output rather than from `input`.
      ...(input.externalFundingUrl === undefined
        ? {}
        : { externalFundingUrl: links.value.externalFundingUrl }),
      ...(input.externalContactUrl === undefined
        ? {}
        : { externalContactUrl: links.value.externalContactUrl }),
    })
    .where(eq(pitch.id, pitchId))
    .returning();

  if (!updated) return { success: false, error: { type: "PITCH_NOT_FOUND" } };
  const refreshed = await readPitchViewById(updated.id);
  if (!refreshed) throw new Error("pitch write: re-read found no row");
  return { success: true, value: refreshed };
}

/**
 * Submits a pitch for review: `draft` or `rejected` → `pending`.
 *
 * TWO THINGS ARE CHECKED HERE THAT ARE NOT CHECKED ON EDIT, because a draft is allowed to
 * be half-finished and a submission is not:
 *
 *  1. THE PROJECT MUST BE PUBLIC. Publishing a pitch for a `draft` project would put its
 *     name, tagline and video in front of strangers through a side door, when the founder
 *     has not published the project itself. The pitch's own review cannot be the thing
 *     that discloses it.
 *  2. THERE MUST BE SOMEWHERE TO SEND PEOPLE. A pitch with neither a funding link nor a
 *     contact link is a advertisement with no call to action — and since Qatoto hosts no
 *     funding control of its own, those two URLs are the entire mechanism.
 */
export async function submitPitch(
  pitchId: string,
  callerUserId: string,
): Promise<Result<PitchView, PitchError>> {
  const owned = await findOwnedPitch(pitchId, callerUserId);
  if (!owned.success) return owned;

  const current = owned.value.row;
  if (current.status !== "draft" && current.status !== "rejected") {
    return { success: false, error: { type: "PITCH_NOT_SUBMITTABLE", status: current.status } };
  }

  const [project] = await db
    .select({ status: researchProject.status })
    .from(researchProject)
    .where(eq(researchProject.id, current.projectId));
  if (!project) return { success: false, error: { type: "PROJECT_NOT_FOUND" } };
  if (project.status !== "active") {
    return { success: false, error: { type: "PROJECT_NOT_PUBLIC", status: project.status } };
  }

  if (current.externalFundingUrl === null && current.externalContactUrl === null) {
    return {
      success: false,
      error: { type: "PITCH_INCOMPLETE", missingField: "externalFundingUrl" },
    };
  }

  // Conditional WHERE rather than a read-then-write: two submits racing must not both win,
  // and the status guard in SQL is what decides it.
  const [updated] = await db
    .update(pitch)
    .set({ status: "pending", rejectionReason: null })
    .where(and(eq(pitch.id, pitchId), sql`${pitch.status} IN ('draft', 'rejected')`))
    .returning();

  if (!updated) {
    return { success: false, error: { type: "PITCH_NOT_SUBMITTABLE", status: current.status } };
  }
  const refreshed = await readPitchViewById(updated.id);
  if (!refreshed) throw new Error("pitch write: re-read found no row");
  return { success: true, value: refreshed };
}

/**
 * Closes a published pitch — the founder is no longer raising.
 *
 * NOT A DELETE. The row stays and its slug keeps resolving, because a closed pitch is the
 * honest answer to somebody following a link from elsewhere; a 404 would suggest it never
 * existed. Only a `published` pitch can be closed; there is nothing to close before that.
 */
export async function closePitch(
  pitchId: string,
  callerUserId: string,
): Promise<Result<PitchView, PitchError>> {
  const owned = await findOwnedPitch(pitchId, callerUserId);
  if (!owned.success) return owned;

  if (owned.value.row.status !== "published") {
    return {
      success: false,
      error: { type: "PITCH_NOT_CLOSEABLE", status: owned.value.row.status },
    };
  }

  const [updated] = await db
    .update(pitch)
    .set({ status: "closed" })
    .where(and(eq(pitch.id, pitchId), eq(pitch.status, "published")))
    .returning();

  if (!updated) {
    return {
      success: false,
      error: { type: "PITCH_NOT_CLOSEABLE", status: owned.value.row.status },
    };
  }
  const refreshed = await readPitchViewById(updated.id);
  if (!refreshed) throw new Error("pitch write: re-read found no row");
  return { success: true, value: refreshed };
}

/**
 * Deletes a pitch. DRAFTS ONLY.
 *
 * Anything that has been in front of a moderator or in front of the public is a record, not
 * a possession: a published pitch has an audit entry naming the staff member who allowed it,
 * and a rejected one is the evidence behind that decision. `close` is the exit for those.
 */
export async function deletePitch(
  pitchId: string,
  callerUserId: string,
): Promise<Result<{ readonly deletedPitchId: string }, PitchError>> {
  const owned = await findOwnedPitch(pitchId, callerUserId);
  if (!owned.success) return owned;

  if (owned.value.row.status !== "draft") {
    return {
      success: false,
      error: { type: "PITCH_NOT_DELETABLE", status: owned.value.row.status },
    };
  }

  const [deleted] = await db
    .delete(pitch)
    .where(and(eq(pitch.id, pitchId), eq(pitch.status, "draft")))
    .returning({ id: pitch.id });

  if (!deleted) {
    return {
      success: false,
      error: { type: "PITCH_NOT_DELETABLE", status: owned.value.row.status },
    };
  }
  return { success: true, value: { deletedPitchId: deleted.id } };
}

// --- Reads -----------------------------------------------------------------

/**
 * One published pitch, by slug. THE PUBLIC READ.
 *
 * `published` only — a `closed` pitch is deliberately excluded from this read and served by
 * the same route with its own copy, so nothing that is no longer raising renders as if it
 * were. Anything else 404s: a `pending` pitch must not be discoverable by guessing a slug,
 * or the review queue leaks.
 */
export async function getPublicPitch(pitchSlug: string): Promise<Result<PitchView, PitchError>> {
  const [found] = await db
    .select({
      row: pitch,
      projectSlug: researchProject.slug,
      projectName: researchProject.name,
      ...PITCH_VIDEO_COLUMNS,
    })
    .from(pitch)
    .innerJoin(researchProject, eq(researchProject.id, pitch.projectId))
    .leftJoin(video, PITCH_VIDEO_JOIN)
    .where(
      and(
        eq(pitch.slug, pitchSlug),
        sql`${pitch.status} IN ('published', 'closed')`,
        // Belt and braces: a public read never returns a pitch whose project was withdrawn.
        eq(researchProject.status, "active"),
      ),
    );

  if (!found) return { success: false, error: { type: "PITCH_NOT_FOUND" } };
  return {
    success: true,
    value: toPitchView(found.row, { slug: found.projectSlug, name: found.projectName }, found),
  };
}

/** The public discovery list. Published only, newest first. */
export async function listPublicPitches(options: {
  readonly page: number;
  readonly limit: number;
  readonly projectSlug?: string | undefined;
}): Promise<{ readonly rows: readonly PitchView[]; readonly total: number }> {
  const conditions = [
    eq(pitch.status, "published"),
    isNotNull(pitch.publishedAt),
    eq(researchProject.status, "active"),
  ];
  if (options.projectSlug !== undefined) {
    conditions.push(eq(researchProject.slug, options.projectSlug));
  }
  const whereClause = and(...conditions);

  const [rows, [counted]] = await Promise.all([
    db
      .select({
        row: pitch,
        projectSlug: researchProject.slug,
        projectName: researchProject.name,
        ...PITCH_VIDEO_COLUMNS,
      })
      .from(pitch)
      .innerJoin(researchProject, eq(researchProject.id, pitch.projectId))
      .leftJoin(video, PITCH_VIDEO_JOIN)
      .where(whereClause)
      // §4c rule 4: the ORDER BY that feeds pagination ends in a UNIQUE column, or a page
      // boundary silently skips rows.
      .orderBy(desc(pitch.publishedAt), desc(pitch.id))
      .limit(options.limit)
      .offset((options.page - 1) * options.limit),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(pitch)
      .innerJoin(researchProject, eq(researchProject.id, pitch.projectId))
      .where(whereClause),
  ]);

  return {
    rows: rows.map((entry) =>
      toPitchView(entry.row, { slug: entry.projectSlug, name: entry.projectName }, entry),
    ),
    total: counted?.total ?? 0,
  };
}

/**
 * Every published slug, for `generateStaticParams`.
 *
 * Public and unauthenticated, exactly like `GET /research-programs/slugs`. It returns slugs
 * and nothing else — a build step needs addresses, not content.
 */
export async function listPublishedPitchSlugs(): Promise<readonly string[]> {
  const rows = await db
    .select({ slug: pitch.slug })
    .from(pitch)
    .innerJoin(researchProject, eq(researchProject.id, pitch.projectId))
    .where(and(eq(pitch.status, "published"), eq(researchProject.status, "active")))
    .orderBy(desc(pitch.publishedAt), desc(pitch.id));
  return rows.map((row) => row.slug);
}

/**
 * Every pitch across every project the caller FOUNDS — the `/studio/pitches` read.
 *
 * FOUNDER-SCOPED, matching the writes exactly. There is no `?userId=` parameter and there
 * must never be one: the filter is `req.user.id`, and a client-supplied user id on a
 * personal list is a client-supplied authorization input.
 */
export async function listMyPitches(
  founderUserId: string,
  options: {
    readonly page: number;
    readonly limit: number;
    readonly status?: PitchStatus | undefined;
  },
): Promise<{ readonly rows: readonly PitchView[]; readonly total: number }> {
  const conditions = [eq(researchProject.founderUserId, founderUserId)];
  if (options.status !== undefined) conditions.push(eq(pitch.status, options.status));
  const whereClause = and(...conditions);

  const [rows, [counted]] = await Promise.all([
    db
      .select({
        row: pitch,
        projectSlug: researchProject.slug,
        projectName: researchProject.name,
        ...PITCH_VIDEO_COLUMNS,
      })
      .from(pitch)
      .innerJoin(researchProject, eq(researchProject.id, pitch.projectId))
      .leftJoin(video, PITCH_VIDEO_JOIN)
      .where(whereClause)
      .orderBy(desc(pitch.createdAt), desc(pitch.id))
      .limit(options.limit)
      .offset((options.page - 1) * options.limit),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(pitch)
      .innerJoin(researchProject, eq(researchProject.id, pitch.projectId))
      .where(whereClause),
  ]);

  return {
    rows: rows.map((entry) =>
      toPitchView(entry.row, { slug: entry.projectSlug, name: entry.projectName }, entry),
    ),
    total: counted?.total ?? 0,
  };
}
