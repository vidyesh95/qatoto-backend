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
    writeUp: z.string().max(10_000, "Keep the write-up under 10,000 characters.").nullable(),
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

export const ShowcaseReviewQueueQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();
