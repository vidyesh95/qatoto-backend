import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  date,
  index,
  uniqueIndex,
  check,
  primaryKey,
  pgEnum,
} from "drizzle-orm/pg-core";

import { user } from "#src/db/schema/_core.js";
import { citext, tsvector } from "#src/db/schema/_primitives.js";
// FIRST EDGE FROM STUDIO TO R&D. `store.ts` and `platform.ts` already import
// `researchProject`; this is the third. The FK direction is video -> project.
import { projectOpenRole, researchProject } from "#src/db/schema/rnd.js";
import { product } from "#src/db/schema/store.js";

// ---------------------------------------------------------------------------
// Creator Studio video domain. See docs/STUDIO_BACKEND_STRUCTURE.md §0-§13.
//
// APPENDIX A (self-hosted video via Livepeer) IS DEFERRED AND NOT BUILT. Nothing
// below is written by an upload, a transcode webhook or a TUS client, because none
// of those exist. What ships is the YouTube-link path: the creator pastes a URL,
// the server parses it to an 11-character id, proves the video exists with one
// oEmbed call, and stores THE ID. No video bytes ever touch this server.
//
// THREE RULES THAT GOVERN EVERY TABLE BELOW:
//
//  1. ZERO-TRUST (§0). `creatorId`/`ownerId` is ALWAYS req.user.id, never a body
//     field. Media facts (videoSource, uploadStatus, youtubeVideoId, thumbnailUrl)
//     are server-derived; a client that sends one is rejected by `.strict()`.
//     The stored YouTube value is the ID, never the client's URL — every embed URL
//     is rebuilt server-side by src/lib/youtube.ts buildYoutubeEmbedUrl.
//
//  2. THE PROVIDER COLUMNS ARE INTENTIONALLY DEAD. storageProvider, videoAssetId,
//     playbackId and playbackUrl are nullable and written by nothing, and
//     videoSourceEnum already carries a "hosted" variant. That is what makes
//     Appendix A an INSERT rather than a migration — no table drop, no rename.
//     Do not populate them from the YouTube path, and do not delete them.
//
//  3. ONE UI STATUS IS THREE ORTHOGONAL COLUMNS (§4). uploadStatus is the media
//     lifecycle, publishStatus the creator's distribution choice, reviewStatus the
//     moderation verdict. Mixing them into one field permits "published while still
//     processing". The frontend's single badge is DERIVED from the three on read.
//
// NAMES THAT LOOK LIKE NEIGHBOURS BUT ARE NOT — do not merge these:
//   videoOpenRole   is NOT projectOpenRole (§4 R&D). No applications, no equity, no
//                   openRoleStatusEnum; it is a recruiting blurb on a watch page.
//   videoTeamMember is NOT projectMember. It is a display credit, not a membership
//                   with intervals, effort or an equity claim.
//   videoMilestone  is NOT the R&D/escrow milestone. It bears NO money: it is a
//                   roadmap label rendered under a video. The escrow cascade note at
//                   the top of the R&D section does not apply here.
// ---------------------------------------------------------------------------

// Where the bytes live. "youtube" is the only value produced today.
export const videoSourceEnum = pgEnum("video_source", ["youtube", "hosted"]);

// Qatoto-surface visibility. NOTE what this does NOT mean for a YouTube row:
// "private"/"unlisted" hide the row in Qatoto's own lists, they do NOT protect the
// video — the bytes are on youtube.com and anyone with the link can watch. That is
// why "investor_only" is REFUSED for youtube rows (see video_gating_ck below)
// rather than pretended: claiming otherwise would be a false security promise.
export const videoVisibilityEnum = pgEnum("video_visibility", [
  "private",
  "unlisted",
  "public",
  "investor_only",
]);

export const videoTypeEnum = pgEnum("video_type", [
  "pitch",
  "demo",
  "update",
  "ama",
  // The curated branch: never self-publishes, always routes through staff review.
  "anime_episode",
]);

export const videoStageEnum = pgEnum("video_stage", ["idea", "mvp", "scaling", "shipped"]);

// Media lifecycle — SERVER-SET, never the client. A YouTube row is born "ready".
// "uploading"/"processing" belong to the deferred hosted path and never occur today.
// "failed" is reserved for the §5.1 re-check job (also deferred), which flips a row
// when the creator deletes or privates the video on youtube.com after the fact.
export const videoUploadStatusEnum = pgEnum("video_upload_status", [
  "uploading",
  "processing",
  "ready",
  "failed",
]);

export const videoPublishStatusEnum = pgEnum("video_publish_status", [
  "draft",
  "scheduled",
  "published",
]);

// Moderation state. "not_required" for ordinary videos; an anime episode moves to
// "pending" on publish and only a moderator can move it on from there.
export const contentReviewStatusEnum = pgEnum("content_review_status", [
  "not_required",
  "pending",
  "approved",
  "rejected",
]);
/**
 * A FOURTH ORTHOGONAL STATUS ON `video`, and the reason it is a new column rather than a
 * value on one of the three that already exist.
 *
 * `review_status: 'rejected'` is the ANIME QUEUE's verdict — an episode that never came out
 * of pre-publication review. Reusing it for "a moderator took this down after a report"
 * would merge two facts a creator experiences completely differently and would put reported
 * videos into the anime review queue's `pending`/`rejected` counts. `publish_status: 'draft'`
 * is worse: it says the CREATOR chose not to publish, and handing a moderator the creator's
 * own switch loses the distinction the moment anyone looks at the row.
 *
 * TWO VALUES, not commerce's four. `commerce_ugc_visibility_state` needs
 * `hidden_pending_review` because a threshold can hide something with no human involved, and
 * `removed_by_author` because a review's author can retract it. Neither exists here: every
 * hide names a moderator, and a creator retracting their own video is `publish_status`.
 */
export const videoModerationVisibilityStateEnum = pgEnum("video_moderation_visibility_state", [
  "visible",
  "hidden_by_moderator",
]);

export const videoLicenseEnum = pgEnum("video_license", ["standard", "creative_commons"]);

export const shortsRemixEnum = pgEnum("shorts_remix", ["video_and_audio", "audio_only"]);

export const videoCollaboratorStatusEnum = pgEnum("video_collaborator_status", [
  "invited",
  "accepted",
  "declined",
]);

// Which provider stored the asset. EVERY ROW IS NULL TODAY (Appendix A).
export const storageProviderEnum = pgEnum("storage_provider", [
  "livepeer",
  "cloudflare",
  "imagekit",
  "self_hosted",
]);

/**
 * The content taxonomy behind the home feed's filter chips and "What's on your mind?"
 * tiles (HOME_BACKEND_STRUCTURE.md §2).
 *
 * A TABLE, NOT A pgEnum, for the same reason as researchCategory: categories carry an
 * image and a display order, they are added and retired by product decision rather than
 * by schema change, and an enum cannot hold an imageUrl.
 *
 * IMAGE NULLABILITY IS LOAD-BEARING, and it deviates from §2's draft on purpose. The
 * seed set has two populations: 12 curated TILES, which have commissioned art, and 11
 * topical CHIPS, which render as a label and have no art in existence. Making imageUrl
 * NOT NULL would force a placeholder onto those 11 — asserting an image that is not
 * real, which is the same class of error as fabricating a zero (§0 Rule 5). Instead the
 * doc's actual invariant, "a tile with no image is a broken tile", is written as the
 * implication below. It is deliberately one-directional: a chip may gain art without
 * being promoted into the curated tile grid.
 */
export const contentCategory = pgTable(
  "content_category",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // Kebab-case, server-generated, public, and linked the moment it exists — therefore
    // UNWRITABLE after creation. The regex is byte-identical to research_category_slug_ck;
    // §5.1's `?categorySlug=` query parameter must reuse this same literal, or a slug this
    // table accepts becomes one the feed route rejects.
    slug: text("slug").notNull(),
    label: text("label").notNull(),
    // The tile image. NULL for a chip — see the header note.
    imageUrl: text("image_url"),
    // Which of the two home-page surfaces this category was curated for. A tile is
    // rendered as art in the "What's on your mind?" grid; a chip is rendered as a label
    // in the filter row. Both appear in the chip row; only tiles appear in the grid.
    isTile: boolean("is_tile").default(false).notNull(),
    sortOrder: integer("sort_order").notNull(),
    // Retiring a category is `isActive = false`, which is reversible and which
    // video_category's RESTRICT FK is designed around. Deleting one is not.
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("content_category_slug_unq").on(table.slug),
    // The only read pattern: the chip row and the tile grid, both ordered.
    index("content_category_active_order_idx").on(table.isActive, table.sortOrder),
    check("content_category_slug_ck", sql`slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check("content_category_tile_image_ck", sql`is_tile = false OR image_url IS NOT NULL`),
  ],
);

// A video, owned by exactly one creator.
export const video = pgTable(
  "video",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // Owner. Stamped from req.user.id at create — NEVER from the body (§0). Cascade
    // matches product.sellerId: a video bears no ledger, equity or audit weight, so
    // it is a possession that dies with the account rather than a record that must
    // outlive it. (contentReviewAction.reviewerId is the opposite case — see there.)
    creatorId: text("creator_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    // --- Where the video lives ---
    videoSource: videoSourceEnum("video_source").default("youtube").notNull(),
    // The 11-character id, NEVER the raw client URL (§0). NULL only when
    // videoSource = "hosted", which nothing produces today. The format CHECK below
    // is what makes this value safe to interpolate into an outbound oEmbed URL.
    youtubeVideoId: text("youtube_video_id"),
    /**
     * Has the id above been PROVEN to resolve to a public, embeddable video
     * (HOME_BACKEND_STRUCTURE.md §8.3)?
     *
     * THIS FLAG IS NOT A SECURITY BOUNDARY, and confusing it for one would be the
     * dangerous reading. `video_youtube_id_format_ck` below is what closes SSRF, and it
     * applies to every row regardless of this column. This flag answers a different
     * question: does the video exist and will it play?
     *
     * WHY IT EXISTS. Verification used to be synchronous inside createVideo, so a
     * YouTube outage threw away the creator's upload with a 502. Now the id is stored
     * regardless, the row is born a draft with this flag false, and `verify-youtube-video`
     * retries with backoff until it flips. The invariant "no unverified id in a published
     * row" is preserved WITHOUT discarding the upload.
     *
     * THREE READERS ENFORCE IT: publishVideo refuses while false, content-review approve
     * refuses while false, and §4.5's feed candidate pool requires it true. A fourth
     * reader of youtubeVideoId added later must check it too — this comment is the only
     * thing that will tell them.
     *
     * Existing rows were backfilled to true in the migration that added this column:
     * every one of them went through the old synchronous verify.
     */
    isSourceVerified: boolean("is_source_verified").default(false).notNull(),

    // --- Provider-neutral media identity. ALL NULL TODAY (Appendix A, rule 2). ---
    storageProvider: storageProviderEnum("storage_provider"),
    videoAssetId: text("video_asset_id"),
    playbackId: text("playback_id"),
    playbackUrl: text("playback_url"),

    uploadStatus: videoUploadStatusEnum("upload_status").default("ready").notNull(),
    // NULL on every YouTube row: oEmbed returns no duration. That is why the chapter
    // validator's "<= durationSeconds" bound is written as a null-guard and skipped
    // here, rather than as a videoSource check (§6).
    durationSeconds: integer("duration_seconds"),
    // Both NULL for YouTube. The upload modal builds its draft with fileName set to
    // the YouTube URL and fileSizeInBytes 0 — a frontend placeholder, not contract.
    // Those values are DISCARDED, and the create schema has no field to send them in.
    sizeBytes: integer("size_bytes"),
    originalFileName: text("original_file_name"),
    // oEmbed's thumbnail_url (host-allowlisted before it is stored), OR a Cloudinary
    // custom upload. The flag below says which, so DELETE knows whether we own an
    // asset to destroy — without it, deleting a video either orphans a Cloudinary
    // asset or 503s on a box that has no Cloudinary credentials configured.
    thumbnailUrl: text("thumbnail_url"),
    hasCustomThumbnail: boolean("has_custom_thumbnail").default(false).notNull(),

    // --- Details step ---
    title: text("title").notNull(),
    description: text("description"),
    videoType: videoTypeEnum("video_type").default("demo").notNull(),
    stageBadge: videoStageEnum("stage_badge"),
    sectorTags: text("sector_tags").array().notNull().default([]),
    websiteUrl: text("website_url"),
    ctaLabel: text("cta_label"),
    ctaUrl: text("cta_url"),
    linkedinUrl: text("linkedin_url"),
    xProfileUrl: text("x_profile_url"),
    contactEmail: text("contact_email"),
    // Nullable because a draft legitimately has not answered yet. Publishing with it
    // still NULL is refused in the service — for a COPPA-shaped attestation, silently
    // shipping "unanswered" is the failure mode that counts.
    isMadeForKids: boolean("is_made_for_kids"),
    hasAgeRestriction: boolean("has_age_restriction").default(false).notNull(),

    // --- Video elements step (scalar links; repeating groups are child tables) ---
    relatedVideoUrl: text("related_video_url"),
    // Deliberately NOT a foreign key and deliberately NOT client-writable: the pitch
    // domain does not exist yet (§12). Accepting it today would store an unvalidated
    // client string that the eventual FK migration would choke on.
    attachedPitchId: text("attached_pitch_id"),
    /**
     * THE VENTURE THIS VIDEO BELONGS TO — the mirror of `product.researchProjectId` (§11i).
     *
     * Unlike `attachedPitchId` directly above, this one IS a foreign key and IS client-settable,
     * because the thing it points at exists. Null means unaffiliated content — anime, general
     * creator uploads — so those surfaces are untouched.
     *
     * `restrict`: a venture with videos attached is not silently deletable. The edge points
     * video -> project, which is why it carries none of the delete-semantics hazard that ruled
     * out a `dailyLog.videoId` edge — a user account still cascades into its own videos, and no
     * effort evidence ends up behind a possession.
     *
     * WHO MAY SET IT IS A SERVICE CONCERN. `creatorId` is a plain `user`; venture identity is a
     * `projectMember`. The write path re-verifies active membership and that the project is
     * `active` before accepting a value, the same shape as `videoAttachedProduct` re-verifying
     * product ownership. A column cannot express that, so do not read this FK as authorization.
     */
    researchProjectId: text("research_project_id").references(
      (): AnyPgColumn => researchProject.id,
      { onDelete: "restrict" },
    ),
    hasFundingCallToAction: boolean("has_funding_cta").default(false).notNull(),

    // --- Visibility step ---
    visibility: videoVisibilityEnum("visibility").default("private").notNull(),
    isNdaRequired: boolean("is_nda_required").default(false).notNull(),
    scheduledPublishAt: timestamp("scheduled_publish_at"),

    // --- The three orthogonal status columns (rule 3) ---
    publishStatus: videoPublishStatusEnum("publish_status").default("draft").notNull(),
    publishedAt: timestamp("published_at"),
    reviewStatus: contentReviewStatusEnum("review_status").default("not_required").notNull(),
    rejectionReason: text("rejection_reason"),
    /**
     * A FOURTH ORTHOGONAL STATUS, and rule 3 above is exactly why it is its own column: the
     * three beside it are the media lifecycle, the CREATOR's distribution choice, and the
     * PRE-publication verdict. This is a POST-publication one, taken by staff on a video
     * that was already live, and folding it into any of the three loses who decided what.
     *
     * WRITTEN ONLY BY `video-content-reports.service.ts`, never by a creator route. A
     * creator cannot clear it — that is the point of a takedown — and the restore route is
     * the only path back to `visible`.
     *
     * EVERY PUBLIC READ MUST FILTER ON IT. There are three copies of that predicate in this
     * codebase and all three carry this term: `PUBLICLY_SERVABLE` (public-video-gate.ts),
     * `publicVideoPredicate()` (feed.service.ts) and `publicVideoPredicateSql()`
     * (spotlight.service.ts). A new read that forgets it serves hidden content, and nothing
     * will fail to tell you.
     */
    moderationVisibilityState: videoModerationVisibilityStateEnum("moderation_visibility_state")
      .default("visible")
      .notNull(),

    // --- "Show more" advanced fields ---
    license: videoLicenseEnum("license").default("standard").notNull(),
    tags: text("tags").array().notNull().default([]),
    videoLanguage: text("video_language"),
    isEmbeddingAllowed: boolean("is_embedding_allowed").default(true).notNull(),
    areCommentsEnabled: boolean("are_comments_enabled").default(true).notNull(),
    shouldShowLikesCount: boolean("should_show_likes_count").default(true).notNull(),
    hasPaidPromotion: boolean("has_paid_promotion").default(false).notNull(),
    usesAlteredContent: boolean("uses_altered_content"),

    // The long-tail "show more" preferences. DEVIATION FROM SPEC §4, which put these
    // seven in a `jsonb("settings")` bag: this schema has no jsonb column anywhere
    // and rejects jsonb by name for exactly this shape (see the compensation-strand
    // note in the R&D section). An untyped jsonb also reads back as `unknown`, which
    // forces either a banned `as` or a parse on every read. Seven nullable scalars on
    // a table that already carries forty is not the thing that makes it unmanageable.
    captionCertification: text("caption_certification"),
    commentModeration: text("comment_moderation"),
    commentSortOrder: text("comment_sort_order"),
    shortsRemixing: shortsRemixEnum("shorts_remixing"),
    recordingDate: date("recording_date"),
    recordingLocation: text("recording_location"),
    /**
     * DEAD COLUMN. Superseded by `video_category` (HOME_BACKEND_STRUCTURE.md §2.2).
     *
     * Free text, unindexed, and validated by nobody — filtering on it would be a LIKE
     * over a column no schema ever constrained. Every write path was removed when
     * `categoryIds` landed; the read in `toPublicVideo` survives for ONE release so that
     * dropping the column and dropping its last reader are two separate deploys. Doing
     * both at once is how you find out in production that something still read it.
     *
     * `scripts/backfill-video-categories.ts` maps the confident values onto video_category
     * and prints the rest for a human. Remove this column once that list is resolved.
     */
    category: text("category"),

    /**
     * What `GET /feed/search` matches against.
     *
     * GENERATED AND STORED, NOT A TRIGGER AND NOT A JOB. Postgres recomputes it inside the
     * same UPDATE that changes a title, so the index cannot drift from the row it describes
     * and there is no backfill to run, nothing to re-enqueue after a failed job, and no
     * window where an edited title is findable under its old wording.
     *
     * THE THREE WEIGHTS ARE THE RANKING, and `ts_rank_cd` reads them: a title hit (A) must
     * outrank a description hit (C) for the same term, or searching "beni" returns whichever
     * video happens to mention it most rather than the ones named for it. Tags sit between
     * the two — a creator chose them deliberately, which is more signal than prose, and less
     * than the title.
     *
     * IT CANNOT INCLUDE THE CREATOR'S NAME. A generated column may only reference its OWN
     * row, and the handle lives on `"user"`. Creator matching is therefore a separate,
     * lower-ranked term evaluated at query time in `searchVideos` — not an omission.
     *
     * `english`, not `simple`, so "robots" finds "robot". The cost is that the stemmer is
     * language-specific and `videoLanguage` is not consulted; a per-language configuration
     * would mean a different generated expression per row, which a generated column cannot
     * express. One config, chosen for the catalogue that exists.
     *
     * ⚠️ `text_array_to_search_text`, NOT `array_to_string`. A generated expression must be
     * IMMUTABLE, and `array_to_string` is only STABLE — Postgres refuses this column outright
     * ("generation expression is not immutable") if it appears here. The wrapper, created in
     * the same migration, is `array_to_string` narrowed to `text[]`, where the underlying
     * output function genuinely is immutable. The marker is a fact about `text[]`, not a
     * promise being made on behalf of a type that cannot keep it.
     */
    searchDocument: tsvector("search_document").generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
          setweight(to_tsvector('english', text_array_to_search_text(tags)), 'B') ||
          setweight(to_tsvector('english', coalesce(description, '')), 'C')`,
    ),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("video_creatorId_idx").on(table.creatorId),
    // GIN, not b-tree: `@@` against a tsvector is a containment test over lexemes, which is
    // exactly what an inverted index answers and what a b-tree cannot answer at all.
    index("video_search_document_idx").using("gin", table.searchDocument),
    index("video_publishStatus_idx").on(table.publishStatus),
    // Composite, not two singles: the admin queue filters reviewStatus AND videoType
    // together and nothing filters videoType alone.
    index("video_reviewStatus_videoType_idx").on(table.reviewStatus, table.videoType),
    // INDEXED BUT NOT UNIQUE, on purpose. Two Qatoto rows may legitimately point at
    // one YouTube video — a creator re-listing a demo under a new pitch, or two
    // founders each linking the launch video. Abuse is bounded by the per-user rate
    // limiter on POST /videos, not by a constraint that also blocks the honest case.
    index("video_youtubeVideoId_idx").on(table.youtubeVideoId),
    // PARTIAL, matching `product_researchProjectId_idx`. Two reads use it — the venture's
    // own reel and the watch page's badge — and both ask only about rows that HAVE a
    // venture. Anime and general uploads are NULL forever and are the large majority, so
    // indexing them would be paying for the rows no query names.
    index("video_research_project_idx")
      .on(table.researchProjectId)
      .where(sql`research_project_id IS NOT NULL`),
    // Partial on purpose. Postgres treats NULLs as distinct, so a plain unique index
    // over an all-NULL column is harmless today — but the WHERE states the intent,
    // and the intent is what has to survive the switch to self-hosting.
    uniqueIndex("video_asset_unq")
      .on(table.videoAssetId)
      .where(sql`video_asset_id is not null`),
    /**
     * The home feed's candidate pool (HOME_BACKEND_STRUCTURE.md §4.5), as a PARTIAL index.
     *
     * WHY PARTIAL AND NOT A COMPOSITE. Every term in §4.5's static filter is a
     * low-cardinality enum or boolean, so a b-tree leading on them is nearly useless —
     * the planner would scan a huge fraction of the index to find the published rows.
     * Moving the whole static filter into the PREDICATE makes the index *be* the
     * candidate pool: it holds only rows that can ever be served, and its single key
     * column is the one the feed actually ranges and sorts on.
     *
     * THE TRAP, and it fails silently. Postgres uses a partial index only when it can
     * PROVE the query's WHERE implies this predicate. Proof works against literals, not
     * against bound parameters — `review_status = ANY($1)` does not imply
     * `review_status IN ('not_required','approved')` as far as the planner is concerned.
     * The §4.5 query must therefore spell these five terms out literally and identically.
     * Get it wrong and there is no error anywhere; there is just a sequential scan.
     *
     * Built now rather than with §4.5 in phase 3 because CREATE INDEX (drizzle-kit does
     * not emit CONCURRENTLY) takes a lock that blocks every write to this table for the
     * duration. That is free today and a studio outage later.
     */
    index("video_feed_candidate_idx")
      .on(table.publishedAt.desc())
      .where(
        sql`publish_status = 'published'
            AND visibility = 'public'
            AND upload_status = 'ready'
            AND is_source_verified = true
            AND review_status IN ('not_required', 'approved')`,
      ),

    // A youtube row with no id is a dead player; a hosted row has no id by design.
    check("video_source_id_ck", sql`(video_source <> 'youtube') OR (youtube_video_id IS NOT NULL)`),
    // THIS IS A SECURITY CONSTRAINT, not tidiness. The id is interpolated into an
    // outbound oEmbed URL and into every embed URL the system emits; the charset
    // contains no ".", "/", ":", "@" or "%", which is what closes SSRF and injection
    // at the storage layer even if a future write path forgets to parse.
    check(
      "video_youtube_id_format_ck",
      sql`youtube_video_id IS NULL OR youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'`,
    ),
    // Gating a YouTube video is impossible, so the database refuses to record the
    // claim. Enforced in the service on create, PATCH and publish as well; this is
    // the invariant those three checkpoints are trying to preserve, stated once.
    check(
      "video_gating_ck",
      sql`(video_source <> 'youtube') OR (visibility <> 'investor_only' AND is_nda_required = false)`,
    ),
    // A published row with no publishedAt sorts as NULL and is dropped by every feed
    // ORDER BY — published but invisible, with no error anywhere.
    check(
      "video_published_at_ck",
      sql`(publish_status <> 'published') OR (published_at IS NOT NULL)`,
    ),
    check(
      "video_scheduled_at_ck",
      sql`(publish_status <> 'scheduled') OR (scheduled_publish_at IS NOT NULL)`,
    ),
    // The frontend types the rejected badge's reason as non-optional.
    check(
      "video_rejection_reason_ck",
      sql`(review_status <> 'rejected') OR (rejection_reason IS NOT NULL)`,
    ),
    check("video_sector_tags_ck", sql`cardinality(sector_tags) <= 20`),
    check("video_tags_ck", sql`cardinality(tags) <= 30`),
  ],
);

/**
 * Which categories a video is tagged into (HOME_BACKEND_STRUCTURE.md §2). At most three,
 * enforced in the service — a cardinality bound ACROSS rows is not expressible as a table
 * CHECK, and a trigger to fake one buys nothing here.
 *
 * NO `position` COLUMN, deliberately. §4.3 scores topic affinity as the MAX over a video's
 * categories, so there is no primary and no order to preserve. talentProfileSkill and
 * supplierCapabilityLink are the shape precedent, not videoAttachedProduct — that one has a
 * position because it renders as an ordered list.
 */
export const videoCategory = pgTable(
  "video_category",
  {
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    // RESTRICT, not cascade, and the asymmetry with videoId is the point: deleting a
    // category that videos still use should fail loudly rather than silently untag them.
    // Retiring one is `isActive = false`, which is reversible.
    categoryId: text("category_id")
      .notNull()
      .references(() => contentCategory.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.videoId, table.categoryId] }),
    // The PK covers video -> categories. This is the reverse: the §5.1 category filter
    // reads category -> videos, and without it that is a sequential scan. Built now
    // because building it later locks the table.
    index("video_category_categoryId_idx").on(table.categoryId, table.videoId),
  ],
);

// Manual chapters. The ordering rules (first at 0, strictly ascending, >= 10s apart,
// >= 3 to render) are validated in the service, where the whole set is visible.
export const videoChapter = pgTable(
  "video_chapter",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    startSeconds: integer("start_seconds").notNull(),
    title: text("title").notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("video_chapter_videoId_idx").on(table.videoId),
    uniqueIndex("video_chapter_position_unq").on(table.videoId, table.position),
    check("video_chapter_start_ck", sql`start_seconds >= 0`),
  ],
);

// Shoppable products. Ownership of each product is re-verified against
// product.sellerId before a row lands here (§0) — the client only ever sends ids.
export const videoAttachedProduct = pgTable(
  "video_attached_product",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    pinnedAtSeconds: integer("pinned_at_seconds"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("video_attached_product_videoId_idx").on(table.videoId),
    uniqueIndex("video_product_unq").on(table.videoId, table.productId),
  ],
);

// Pitch deck / whitepaper PDFs.
export const videoDocument = pgTable(
  "video_document",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    fileName: text("file_name").notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("video_document_videoId_idx").on(table.videoId)],
);

// Roadmap labels rendered under the video. Bears no money — see the naming note above.
export const videoMilestone = pgTable(
  "video_milestone",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("video_milestone_videoId_idx").on(table.videoId)],
);

// Recruiting blurbs attached to a video. Viewers APPLYING to one is a future feature
// (§12) and lives in the R&D application tables when it lands, not here.
export const videoOpenRole = pgTable(
  "video_open_role",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    roleTitle: text("role_title").notNull(),
    roleDescription: text("role_description"),
    /**
     * THE REAL ROLE THIS BLURB ADVERTISES, or null.
     *
     * Null keeps today's behaviour exactly: free text that points at nothing, which is right
     * for anime and for any video with no venture. When set, the watch page stops rendering a
     * typed label and starts rendering a projection of the actual `projectOpenRole` — its
     * skills, its commitment, its remaining slots — with an Apply control wired to the R&D
     * application flow that already exists.
     *
     * `roleTitle` STAYS NOT NULL beside it, as the fallback and as what the creator typed.
     *
     * THIS DOES NOT MAKE THE TWO TABLES ONE. The note at the top of this file still holds:
     * `videoOpenRole` carries no equity, no slot counter and no status. It POINTS at the row
     * that does. The service refuses an id that does not belong to the video's own
     * `researchProjectId`, so a video cannot advertise a vacancy at some other venture.
     */
    openRoleId: text("open_role_id").references((): AnyPgColumn => projectOpenRole.id, {
      onDelete: "restrict",
    }),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("video_open_role_videoId_idx").on(table.videoId),
    // Partial: the reverse question — "which videos advertise this role" — only ever asks
    // about linked rows, and unlinked ones are the majority.
    index("video_open_role_open_role_idx")
      .on(table.openRoleId)
      .where(sql`open_role_id IS NOT NULL`),
  ],
);

// A display credit on the watch page. `linkedUserId` ties it to a real account when
// one is known; `set null` because deleting a user must never erase the credit itself.
export const videoTeamMember = pgTable(
  "video_team_member",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    memberName: text("member_name").notNull(),
    roleLabel: text("role_label"),
    linkedUserId: text("linked_user_id").references(() => user.id, { onDelete: "set null" }),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("video_team_member_videoId_idx").on(table.videoId)],
);

export const videoCollaborator = pgTable(
  "video_collaborator",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    invitedEmail: citext("invited_email").notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    status: videoCollaboratorStatusEnum("status").default("invited").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("video_collaborator_videoId_idx").on(table.videoId),
    // ADDITION TO SPEC §4. One live invite per address per video: re-inviting must be
    // an UPDATE, because two rows leave "accept" with no single row to resolve.
    // citext so "A@x.com" and "a@x.com" are the same invite, matching user.email.
    uniqueIndex("video_collaborator_unq").on(table.videoId, table.invitedEmail),
  ],
);
