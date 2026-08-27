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

import { and, desc, eq, isNotNull, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { pitch, researchProject } from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { normalizePitchLinks } from "#src/modules/rnd/pitches/pitch-link.js";
import type { PitchLinkError } from "#src/modules/rnd/pitches/pitch-link.js";
import type {
  CreatePitchInput,
  UpdatePitchInput,
} from "#src/modules/rnd/pitches/pitches.schemas.js";
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
  | PitchLinkError;

/**
 * The wire shape. Money never appears on it because none exists on this table.
 *
 * `externalFundingUrl` and `externalContactUrl` are the NORMALIZED values — what the parser
 * stored, not what was typed — so two clients rendering the same pitch render the same link.
 */
export interface PitchView {
  readonly id: string;
  readonly slug: string;
  readonly projectId: string;
  readonly projectSlug: string;
  readonly projectName: string;
  readonly title: string;
  readonly summary: string;
  readonly pitchVideoId: string | null;
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

function toPitchView(
  row: PitchRow,
  project: { readonly slug: string; readonly name: string },
): PitchView {
  return {
    id: row.id,
    slug: row.slug,
    projectId: row.projectId,
    projectSlug: project.slug,
    projectName: project.name,
    title: row.title,
    summary: row.summary,
    pitchVideoId: row.pitchVideoId,
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
    })
    .from(pitch)
    .innerJoin(researchProject, eq(researchProject.id, pitch.projectId))
    .where(eq(pitch.id, pitchId));

  if (!found) return { success: false, error: { type: "PITCH_NOT_FOUND" } };
  if (found.founderUserId !== callerUserId) {
    return { success: false, error: { type: "NOT_THE_FOUNDER" } };
  }
  return {
    success: true,
    value: {
      row: found.row,
      view: toPitchView(found.row, { slug: found.projectSlug, name: found.projectName }),
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
      return {
        success: true,
        value: toPitchView(created, { slug: project.slug, name: project.name }),
      };
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
  return {
    success: true,
    value: toPitchView(updated, {
      slug: owned.value.view.projectSlug,
      name: owned.value.view.projectName,
    }),
  };
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
  return {
    success: true,
    value: toPitchView(updated, {
      slug: owned.value.view.projectSlug,
      name: owned.value.view.projectName,
    }),
  };
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
  return {
    success: true,
    value: toPitchView(updated, {
      slug: owned.value.view.projectSlug,
      name: owned.value.view.projectName,
    }),
  };
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
    })
    .from(pitch)
    .innerJoin(researchProject, eq(researchProject.id, pitch.projectId))
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
    value: toPitchView(found.row, { slug: found.projectSlug, name: found.projectName }),
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
      .select({ row: pitch, projectSlug: researchProject.slug, projectName: researchProject.name })
      .from(pitch)
      .innerJoin(researchProject, eq(researchProject.id, pitch.projectId))
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
      toPitchView(entry.row, { slug: entry.projectSlug, name: entry.projectName }),
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
      .select({ row: pitch, projectSlug: researchProject.slug, projectName: researchProject.name })
      .from(pitch)
      .innerJoin(researchProject, eq(researchProject.id, pitch.projectId))
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
      toPitchView(entry.row, { slug: entry.projectSlug, name: entry.projectName }),
    ),
    total: counted?.total ?? 0,
  };
}
