/**
 * The column types and enums that are USED ACROSS product-area files, and the one file in
 * `src/db/schema/` that imports none of its siblings.
 *
 * WHY THIS FILE EXISTS AT ALL, because "shared stuff" is not the reason and would not
 * justify separating an enum from the table it describes.
 *
 * The area files reference each other in both directions — `store` needs `user`, `_core`'s
 * session needs `commerceOrganization`, `home` needs `video`. That is fine for a TABLE:
 * every cross-file foreign key in this schema is a thunk, `.references(() => other.id)`,
 * so it resolves long after both modules have finished evaluating and a cycle is harmless.
 *
 * An enum or a customType is not fine. `tsvector("search_document")` and
 * `platformRoleEnum("previous_platform_role")` are CALLED while the module body runs. Put
 * one behind an import cycle and the call lands on a binding still in its temporal dead
 * zone, which is exactly what the first attempt at this split produced:
 *
 *     ReferenceError: Cannot access 'tsvector' before initialization
 *         at src/db/schema/studio.ts:389
 *
 * Nothing type-checks wrong when that happens — it fails at import time, and drizzle-kit
 * reports it as an empty export rather than as a cycle.
 *
 * So the rule is narrow and mechanical: an eagerly-called symbol that crosses a file
 * boundary lives here, because a module that imports nothing always finishes evaluating
 * first. An enum used only inside its own area file stays beside its tables, where its
 * comment is worth reading. Adding an import to this file re-opens the failure above.
 */
import { pgEnum, customType } from "drizzle-orm/pg-core";

// Case-insensitive text (Postgres `citext`). Used for the email columns so that
// equality AND the UNIQUE constraint compare case-insensitively: two providers
// reporting the same address in different case (Google "User@x.com", GitHub
// "user@x.com") resolve to ONE user via Better Auth's email lookup instead of
// minting a duplicate row. Requires the `citext` extension, created in the
// migration that introduces this type. See src/lib/auth.ts accountLinking.
export const citext = customType<{ data: string }>({
  dataType() {
    return "citext";
  },
});

// Postgres' full-text search document type, backing `video.searchDocument`.
//
// IT IS NEVER READ OR WRITTEN BY THE APPLICATION — the column is GENERATED ALWAYS, so
// Postgres computes it and an INSERT or UPDATE that mentions it is an error. The type
// exists so drizzle-kit knows the column is there and does not try to add it on every
// `generate`; `data: string` is the shape the driver would hand back if anyone ever
// selected it, which nothing does.
export const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

// Platform-wide staff role, NOT project-scoped (R_AND_D_BACKEND_STRUCTURE.md §4a
// Layer 3). NULL for ordinary users, which is almost everyone.
export const platformRoleEnum = pgEnum("platform_role", ["moderator", "auditor", "admin"]);

export const playlistVisibilityEnum = pgEnum("playlist_visibility", [
  "public",
  "unlisted",
  "private",
]);

// DEVIATION FROM SPEC §4, which typed this `text(...).default("date_published_newest")`.
// A text column that only ever holds these six values is the loose modelling CLAUDE.md
// Pattern 1 forbids; an enum makes a seventh value unrepresentable in the database.
// Same reasoning applies to the three enums after it.
export const playlistVideoOrderEnum = pgEnum("playlist_video_order", [
  "date_published_newest",
  "date_published_oldest",
  "date_added_newest",
  "date_added_oldest",
  "manual",
]);

/**
 * Whether a moderator has hidden a person's PROFILE TEXT — their bio and links.
 *
 * TWO VALUES, mirroring `video_moderation_visibility_state` rather than inventing a ladder. It
 * gates the bio and the links and nothing else: the name, avatar and every video stay visible,
 * because there is no public-user gate to hang a wider state on and a half-enforced one would be
 * worse than none.
 */
/**
 * Why somebody reported a person's profile.
 *
 * PROFILE-SCOPED, AND NOT A COPY OF `video_content_report_reason`. Every value here names something
 * the only available lever can actually address — hiding a bio and its links. The video eight are
 * about a video's CONTENT, and offering `child_safety` here would promise an action this system
 * cannot take: answering it by hiding a description would be worse than not offering it.
 */
export const userReportReasonEnum = pgEnum("user_report_reason", [
  "impersonation",
  "abusive_profile_text",
  "misleading_links",
  "spam",
  // THE ONE REASON WITH NO MATCHING ACTION, and it is deliberate. Hiding a description does not
  // answer severe harm, so the queue marks these rows as needing something this product cannot do
  // rather than letting a hide-or-dismiss choice imply either was appropriate. It must never
  // acquire an automatic action — see `0142`.
  "severe_harm_escalation",
  "other",
]);

export const userReportStatusEnum = pgEnum("user_report_status", [
  "open",
  "actioned",
  "dismissed",
]);

export const userModerationActionKindEnum = pgEnum("user_moderation_action_kind", [
  "profile_text_hidden",
  "profile_text_restored",
  "report_dismissed",
]);

export const userProfileModerationStateEnum = pgEnum("user_profile_moderation_state", [
  "visible",
  "hidden_by_moderator",
]);

export const animeAudioModeEnum = pgEnum("anime_audio_mode", ["subbed", "dubbed"]);

export const animeSeriesStatusEnum = pgEnum("anime_series_status", [
  "ongoing",
  "completed",
  "hiatus",
]);

// The audit log is the record of record for every moderation decision, so a
// free-text verb in it is one typo away from an unqueryable log.
export const contentReviewActionKindEnum = pgEnum("content_review_action_kind", [
  "approve",
  "reject",
]);
