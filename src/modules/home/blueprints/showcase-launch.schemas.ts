/**
 * Request schemas for showcase launches — posting one, and moderating one.
 *
 * Kept out of the controller for the reason `blueprints.schemas.ts` gives: the OpenAPI body map
 * imports them, and importing a controller would drag its service and database graph along.
 *
 * ⚠️ THE FIELD NAMES AND LIMITS ARE THE FRONTEND'S CONTRACT, byte for byte —
 * `ShowcaseSubmissionDraftSchema` in the frontend's `src/lib/blueprints/showcase-authoring.schemas.ts`.
 * The form mirrors the limits below so a maker is told before posting; this file is what actually
 * refuses. Every limit here also has a CHECK on `showcase_launch`, which is the backstop and never
 * the first line.
 */
import { z } from "zod";

import { blueprintDifficultyEnum } from "#src/db/schema.js";
import {
  deepestWriteUpNestingDepth,
  MAX_SHOWCASE_WRITE_UP_NESTING_DEPTH,
} from "#src/modules/home/blueprints/showcase-write-up-nesting.js";

export const SHOWCASE_LAUNCH_STATEMENT_IDS = ["built_it_ourselves", "results_are_our_own"] as const;

/** A write-up may embed at most this many distinct images. */
export const MAX_SHOWCASE_WRITE_UP_IMAGES = 20;

/**
 * How many uploaded-but-unclaimed write-up images one maker may hold at once.
 *
 * Without a ceiling, the staging area is free image hosting: upload, copy the Cloudinary URL,
 * never post. Thirty is comfortably above one write-up's twenty and far below abuse.
 */
export const MAX_UNCLAIMED_SHOWCASE_WRITE_UP_IMAGES_PER_MAKER = 30;

/** How far ahead of the server clock a launch date may be — a browser clock is never exact. */
export const SHOWCASE_LAUNCH_DATE_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * The byte cap on the multipart `draft` part. The largest legal draft — a 10,000-character
 * write-up, twelve team rows, ten tags, every other field at its maximum — is well under half of
 * this even with every character a four-byte code point.
 */
export const SHOWCASE_DRAFT_PART_MAXIMUM_BYTES = 128 * 1024;

export const SHOWCASE_MODERATOR_NOTE_MAXIMUM_CHARACTERS = 2000;

/**
 * How many MARKUP characters — `*`, `_`, `[`, `]` — one write-up may hold.
 *
 * WHY A SECOND CAP ON A FIELD THAT ALREADY HAS ONE. Matching emphasis and link delimiters is
 * QUADRATIC in the number of delimiters, and `extractWriteUpImageAddresses` parses every write-up
 * on the submit path. Measured on this machine, at the 10,000-character limit alone:
 *
 *   9,800 delimiters (`****…x…****`)  ~800 ms
 *   3,000 delimiters                   ~105 ms
 *   1,188 delimiters                   ~32 ms
 *
 * That cost is synchronous and Node is single-threaded, so the top of that range stalls EVERY
 * other request in flight, not just the maker's own. The character cap cannot bound it: the worst
 * input is well under 10,000 characters.
 *
 * WHY 3,000, AND WHY IT WILL NOT REFUSE REAL WRITE-UPS. A deliberately over-formatted build
 * write-up — bold or italic in every sentence, bulleted specs, block quotes, images and links —
 * measures 1,188 of these characters in 9,746, already 12% of the document. 3,000 leaves 2.5x
 * headroom above that and holds the worst case near 100 ms — measured across giant runs, dense
 * singles, and delimiters interleaved with brackets. Reaching the cap needs roughly one delimiter
 * every three characters, which is not prose.
 *
 * ⚠️ COUNTS ALL FOUR CHARACTERS, not just the emphasis pair. Brackets take part in the same
 * matching: 3,000 emphasis markers interleaved with brackets measured 189 ms, against ~65 ms once
 * the brackets counted toward the same budget. A write-up's links and images contribute a handful
 * of brackets each, so including them costs legitimate content nothing.
 */
export const MAX_SHOWCASE_WRITE_UP_MARKUP_CHARACTERS = 3000;

/** `*`, `_`, `[` and `]` — the characters micromark matches into emphasis and link runs. */
function countWriteUpMarkupCharacters(writeUp: string): number {
  let markupCharacterCount = 0;
  for (const character of writeUp) {
    if (character === "*" || character === "_" || character === "[" || character === "]") {
      markupCharacterCount += 1;
    }
  }
  return markupCharacterCount;
}

const KEBAB_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TEAM_HANDLE_PATTERN = /^[A-Za-z0-9_.-]+$/;

const ShowcaseTeamMemberDraftSchema = z
  .object({
    displayName: z.string().trim().min(1, "Give this person's name.").max(80),
    handle: z
      .string()
      .min(1, "Give their handle.")
      .max(64, "A handle is at most 64 characters.")
      .regex(TEAM_HANDLE_PATTERN, "A handle has no spaces and no @, like amara-builds."),
    role: z.string().trim().min(1, "Say what they did on the build.").max(60),
  })
  .strict();

const ShowcaseCostRangeDraftSchema = z
  .object({
    minimumInCents: z.number().int().min(0).max(100_000_000),
    maximumInCents: z.number().int().min(0).max(100_000_000),
    currency: z.literal("USD"),
  })
  .strict()
  .refine((costRange) => costRange.minimumInCents <= costRange.maximumInCents, {
    path: ["maximumInCents"],
    message: "The highest cost can't be lower than the lowest.",
  });

const ShowcaseCallToActionDraftSchema = z
  .object({
    label: z.string().trim().min(1, "Give the link a label, like Order a unit.").max(40),
    // Shape only. `parseHttpsUrl` in the service is the rule, and it also normalizes what is stored.
    url: z.string().trim().min(1).max(2048),
  })
  .strict();

/**
 * What a maker posts, parsed from the multipart `draft` part.
 *
 * SERVER-OWNED FIELDS ARE REFUSED BY `.strict()`, loudly: an id, a slug, an author, any count, any
 * moderation state. The heading image is not here because it travels as the file part.
 */
export const ShowcaseLaunchDraftSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(8, "A name short enough to skim and specific enough to search.")
      .max(120, "Keep the name under 120 characters."),
    tagline: z
      .string()
      .trim()
      .min(10, "One line that says what it does.")
      .max(80, "Keep the pitch to 80 characters so it fits one feed row."),
    summary: z
      .string()
      .trim()
      .min(40, "One paragraph: what it is, and what it proved.")
      .max(1000, "Keep the summary under 1,000 characters."),
    writeUp: z
      .string()
      .max(10_000, "Keep the write-up under 10,000 characters.")
      // Markup first, then nesting: a genuinely over-formatted write-up hits the markup cap, and
      // that is the message worth listing first when a maker trips both.
      .refine(
        (writeUp) =>
          countWriteUpMarkupCharacters(writeUp) <= MAX_SHOWCASE_WRITE_UP_MARKUP_CHARACTERS,
        `Simplify the formatting — a write-up can hold at most ${String(MAX_SHOWCASE_WRITE_UP_MARKUP_CHARACTERS)} of the characters *, _, [ and ].`,
      )
      .refine(
        (writeUp) => deepestWriteUpNestingDepth(writeUp) <= MAX_SHOWCASE_WRITE_UP_NESTING_DEPTH,
        `Simplify the structure — a write-up can nest lists and quotes at most ${String(MAX_SHOWCASE_WRITE_UP_NESTING_DEPTH)} levels deep.`,
      )
      .nullable(),
    launchedAt: z.iso.datetime({ error: "Pick the day it launched." }),
    difficulty: z.enum(blueprintDifficultyEnum.enumValues, {
      error: "Say how hard it would be to build again.",
    }),
    billOfMaterialsCostRange: ShowcaseCostRangeDraftSchema.nullable(),
    tags: z
      .array(z.string().trim().min(1).max(32, "A tag is at most 32 characters."))
      .max(10, "Up to 10 tags.")
      .refine(
        (tags) => new Set(tags.map((tag) => tag.toLowerCase())).size === tags.length,
        "Each tag appears once.",
      ),
    team: z
      .array(ShowcaseTeamMemberDraftSchema)
      .max(12, "Up to 12 people.")
      .refine(
        (team) =>
          new Set(team.map((teamMember) => teamMember.handle.toLowerCase())).size === team.length,
        "Each person appears once. Two team rows share a handle.",
      ),
    builtFromBlueprintSlug: z
      .string()
      .min(3)
      .max(120)
      .regex(KEBAB_SLUG_PATTERN, "That teardown address is not valid.")
      .nullable(),
    callToAction: ShowcaseCallToActionDraftSchema.nullable(),
    acceptedLaunchStatementIds: z
      .array(z.enum(SHOWCASE_LAUNCH_STATEMENT_IDS))
      .max(SHOWCASE_LAUNCH_STATEMENT_IDS.length)
      .refine(
        (acceptedStatementIds) =>
          SHOWCASE_LAUNCH_STATEMENT_IDS.every((statementId) =>
            acceptedStatementIds.includes(statementId),
          ),
        "Both statements have to be ticked before this can be posted.",
      ),
  })
  .strict();
export type ShowcaseLaunchDraft = z.infer<typeof ShowcaseLaunchDraftSchema>;

/**
 * The multipart text parts of POST /blueprints/showcases, as multer hands them over.
 *
 * ⚠️ THIS IS THE OPENAPI BODY ENTRY, NOT THE VALIDATION. The draft travels as ONE JSON string
 * because team rows and tags are nested and cannot be sent as flat text parts. The controller
 * parses that string behind a guard and validates the result with `ShowcaseLaunchDraftSchema`.
 */
export const SubmitShowcaseLaunchMultipartSchema = z
  .object({
    draft: z.string().min(2).max(SHOWCASE_DRAFT_PART_MAXIMUM_BYTES),
  })
  .strict();

/**
 * A moderator's decision.
 *
 * A NOTE IS REQUIRED TO SEND A LAUNCH BACK and optional to publish one: "no" without a reason is
 * not a review, and "yes" needs none. The key is present on both arms so a client cannot forget
 * it on one.
 */
export const ModerateShowcaseLaunchSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("published"),
      moderatorNote: z.string().trim().max(SHOWCASE_MODERATOR_NOTE_MAXIMUM_CHARACTERS).nullable(),
    })
    .strict(),
  z
    .object({
      decision: z.literal("rejected"),
      moderatorNote: z
        .string()
        .trim()
        .min(1, "Tell the maker why it is being sent back.")
        .max(SHOWCASE_MODERATOR_NOTE_MAXIMUM_CHARACTERS),
    })
    .strict(),
]);
export type ModerateShowcaseLaunchInput = z.infer<typeof ModerateShowcaseLaunchSchema>;

/**
 * The moderator queue's paging controls.
 *
 * ⚠️ `.strip()`, AND IT IS THE ONLY QUERY SCHEMA IN THIS CODEBASE THAT IS — every other one is
 * `.strict()`. The departure is deliberate, so do not "correct" it back.
 *
 * WHY. `.strict()` earns its keep on a BODY, where an unknown key is a client trying to set
 * something the server owns. A query string is not that: it collects parameters nobody in this
 * codebase put there — a `utm_source` from a link in an email, a stale `?page=` in a moderator's
 * bookmark — and refusing the whole request for one of them means the review queue does not load
 * and the reason shown is a key the moderator never typed. Unknown keys are dropped; the ones that
 * decide what is read are still parsed exactly, so `?limit=51` is still a 422.
 */
/**
 * The public feed's two orders. Byte-matches the frontend's `SHOWCASE_SORTS`, because these are wire
 * values a query string carries.
 */
export const SHOWCASE_FEED_SORTS = ["newest", "top"] as const;
export const DEFAULT_SHOWCASE_FEED_SORT = "newest";

/** Byte-matches the frontend's `SHOWCASE_PAGE_LIMIT`, so an unpaged request renders one full page. */
export const SHOWCASE_FEED_DEFAULT_LIMIT = 6;

/**
 * The public showcase feed's query.
 *
 * ⚠️ `.strip()`, NOT `.strict()`, and unlike the moderator queue this is not a close call. This
 * feed is a public page people share: a link pasted into a chat comes back with `utm_source`, a
 * campaign tag or a tracking parameter nobody in this codebase put there, and refusing the whole
 * request for one of them means the page does not load and the reason names a key the reader never
 * typed. Unknown keys are dropped; the ones that decide what is read are still parsed exactly.
 */
export const PublicShowcaseFeedQuerySchema = z
  .object({
    tag: z.string().trim().min(1).max(40).optional(),
    sort: z.enum(SHOWCASE_FEED_SORTS).default(DEFAULT_SHOWCASE_FEED_SORT),
    limit: z.coerce.number().int().min(1).max(24).default(SHOWCASE_FEED_DEFAULT_LIMIT),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strip();

/**
 * A public slug, shaped exactly as `showcase_launch_public_slug_ck` stores one.
 *
 * ⚠️ A FAILURE HERE ANSWERS 404, NOT 422, which departs from §3.1's parse-failure rule on purpose.
 * A 422 for a malformed slug beside a 404 for a well-formed one that does not exist tells a stranger
 * which shapes are real, one request at a time. The parse still runs at the boundary; only the
 * status differs, and both answers are the same answer: there is nothing here.
 */
export const PublicShowcaseSlugSchema = z
  .string()
  .min(3)
  .max(120)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

export const ShowcaseReviewQueueQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strip();
