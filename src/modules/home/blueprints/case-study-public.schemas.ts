import { z } from "zod";

import { CASE_STUDY_DISCIPLINES } from "#src/modules/home/blueprints/case-study-submission.schemas.js";

/** 10 fixtures at 6 per page is two pages, so the paging control renders. */
export const CASE_STUDY_INDEX_DEFAULT_LIMIT = 6;

/**
 * `?discipline=` is the whole filter surface on this index — one typed facet, no sort and no tag
 * chips, which is what `ListCaseStudiesFilter` offers. The other two arms have more; this one does
 * not, and adding a parameter the page has no control for would be inventing a surface.
 *
 * ⚠️ `.strip()`, NOT `.strict()`. A case-study link is shared and comes back carrying `utm_source`,
 * `fbclid` and whatever else an intermediary appended; refusing the request over a tracking
 * parameter nobody in this system added would break a link that works everywhere else. The parse is
 * still total for every parameter this surface DOES read — an out-of-range `limit` is a 422 rather
 * than a clamp, and an unknown `?sort=` is dropped rather than honoured.
 */
export const PublicCaseStudyIndexQuerySchema = z
  .object({
    discipline: z.enum(CASE_STUDY_DISCIPLINES).optional(),
    limit: z.coerce.number().int().min(1).max(24).default(CASE_STUDY_INDEX_DEFAULT_LIMIT),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strip();

export type PublicCaseStudyIndexQuery = z.infer<typeof PublicCaseStudyIndexQuerySchema>;

/**
 * A case study's address, shaped exactly as `case_study_slug_ck` stores one.
 *
 * ⚠️ A FAILURE HERE ANSWERS 404, NOT 422 — the departure the showcase and teardown slug schemas both
 * document. A 422 for a malformed slug beside a 404 for a well-formed one that does not exist tells
 * a stranger which shapes are real, one request at a time. The parse still runs at the boundary;
 * only the status differs, and both answers say the same thing: there is nothing here.
 */
export const PublicCaseStudySlugSchema = z
  .string()
  .min(3)
  .max(120)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

/** The writer's own list and the review queue both page; neither offers a filter. */
export const CaseStudyCursorPageQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strip();

export const CASE_STUDY_MODERATOR_NOTE_MAXIMUM_CHARACTERS = 2000;

/**
 * A moderator's decision on one case study.
 *
 * ⚠️ `published` / `rejected`, THE MODERATION STATE NAMES, matching the launch contract. The
 * pathway route spells its decisions `publish` / `reject`; that spelling is deliberately not
 * copied here, because the frontend's contract already uses the state names.
 *
 * ⚠️ A SEND-BACK MUST SAY WHY. The note is the only thing the writer sees, so a rejection nobody
 * can act on comes back unchanged. Publishing may carry a note or none.
 */
export const CaseStudyModerationDecisionSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("published"),
      moderatorNote: z.string().max(CASE_STUDY_MODERATOR_NOTE_MAXIMUM_CHARACTERS).nullable(),
    })
    .strict(),
  z
    .object({
      decision: z.literal("rejected"),
      moderatorNote: z
        .string()
        .min(1, "Sending back needs a note. It is the only thing the writer sees.")
        .max(CASE_STUDY_MODERATOR_NOTE_MAXIMUM_CHARACTERS),
    })
    .strict(),
]);
