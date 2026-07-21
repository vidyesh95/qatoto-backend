# STUDIO_BACKEND_STRUCTURE.md — Qatoto Creator Studio: Video-Upload API

> This document describes the **video-upload** contract the Next.js Creator Studio depends on,
> and how it is wired on the Express backend (`/Users/vinitchuri/code/backend/qatoto-backend`).
> It is the sibling of [STORE_BACKEND_STRUCTURE.md](STORE_BACKEND_STRUCTURE.md) (product
> listings) and [BACKEND_STRUCTURE.md](BACKEND_STRUCTURE.md) (auth & identity) — same voice,
> same layering (routes → controllers → services), same `Result<T, E>` envelope, same
> zero-trust §0 — scoped to the **video upload** flow at `/studio` and **My Videos** at
> `/studio/videos`.
>
> **Goal:** let a signed-in creator upload a video, fill its metadata (details, chapters,
> shoppable products, pitch/funding/recruit attachments, playlists, visibility tier), publish
> it, and — for **anime episodes** — route it through an admin review queue — with the backend
> as the only source of truth **and running cost kept near zero**.
>
> **Scope:** video **upload** only. **Go Live Stream is explicitly out of scope** (separate
> future doc). Store listings live in [STORE_BACKEND_STRUCTURE.md](STORE_BACKEND_STRUCTURE.md).
>
> ---
>
> ## ⚠️ Read this first — the video source is a YouTube link
>
> **What ships now:** the creator **pastes a YouTube URL**. The backend parses it to an 11-char
> video id, verifies the video is real and embeddable with one free **oEmbed** call, and stores
> **the id**. That's it. The video is `ready` the instant it is created. Playback is a
> `youtube-nocookie.com/embed/<id>` iframe rendered by the client.
>
> **What is DEFERRED and must NOT be built now:** **Livepeer Studio direct upload** — the
> resumable TUS upload, the transcode webhook, the gated-playback JWT, the `videoProvider` seam.
> All of it is preserved, unabridged, in **[Appendix A](#appendix-a--deferred-self-hosted-video-livepeer-direct-upload)**.
> Self-hosting video was deferred on **cost and complexity** grounds. The `LIVEPEER_API_KEY` /
> `LIVEPEER_SIGNING_KEY_*` vars already sitting in the backend `.env.example` stay **unused** —
> do not wire them, do not install a TUS client, do not mount a webhook router.
>
> Sections §0–§13 describe **only** the YouTube-link path. If a section mentions Livepeer, it is
> either a pointer to Appendix A or a bug in this doc.
>
> ---
>
> **Cost stance (headline — see §5):** the backend **never touches video bytes, and neither does
> any provider we pay.** No upload, no transcode, no HLS, no CDN, no storage bill. We persist an
> 11-character string. Running cost for video is **literally zero**, not near-zero. The trade-offs
> that buys (no gating, YouTube chrome, the creator can delete the video out from under us) are
> spelled out honestly in §5.
>
> **Forward compatibility:** the provider-neutral columns (`videoAssetId`, `playbackId`,
> `playbackUrl`, `storageProvider`) stay in the schema **nullable and unused**, and the
> `videoSource` enum already has a `hosted` variant. That is deliberate — when self-hosting lands,
> Appendix A becomes a re-read, not a redesign: **no table drop, no rename, no frontend rewrite.**
>
> **Status:** the frontend upload flow ([create-studio-page.tsx](src/components/studio/pages/create-studio-page.tsx)
> → [upload-modal.tsx](src/components/studio/upload/upload-modal.tsx) →
> [studio-videos-context.tsx](src/state/studio-videos-context.tsx)) is **pure UI + mock data**
> today — saves push into a React `useState` store, nothing is submitted, the video list is a
> seeded array. The YouTube path is already wired on the frontend: `create-studio-page.tsx` has an
> "Add a video from YouTube" URL field validated live by
> [src/lib/youtube.ts](src/lib/youtube.ts), and **the file dropzone below it is deliberately
> `inert` + dimmed** — it stays in the code, non-interactive, for when hosting is switched back on.
> `StudioVideo.youtubeUrl` carries the link. This doc is the spec the backend-integration phase
> implements. The video domain does **not** exist in the backend yet (greenfield: no
> video/playlist/series table or route).

---

## 0. The one rule that governs everything

**The frontend is a hostile, untrusted presentation layer. The backend is the only source of
truth.** (Same NON-NEGOTIABLE principle as [CLAUDE.md](CLAUDE.md) §"thin client",
BACKEND_STRUCTURE.md §0, and STORE_BACKEND_STRUCTURE.md §0 — applied to video.)

Anyone can open DevTools, read the client JS, and forge any request. So for every upload
mutation the backend **re-checks everything, every request, by itself**:

- **Ownership is server-derived.** The creator id comes from `req.user.id` (the session cookie,
  via `requireAuth`), **never** from the request body. A video's `creatorId` is stamped from the
  session at create time and can never be changed by the client.
- **Every `/videos/:id*` route re-verifies ownership** before acting: load the row, confirm
  `video.creatorId === req.user.id`, else respond **`404`** (not `403` — a stranger must not be
  able to probe which video ids exist).
- **The YouTube URL is attacker-controlled — parse it, never echo it.** A client can send any
  string. The backend **parses it server-side** to an 11-char video id against a **hostname
  allowlist** (`youtube.com`, `www.`/`m.`/`music.` subdomains, `youtu.be`,
  `youtube-nocookie.com`) — mirroring [src/lib/youtube.ts](src/lib/youtube.ts) — then stores
  **the id, never the raw URL**. Every embed URL the system emits is **rebuilt server-side** as
  `https://www.youtube-nocookie.com/embed/<id>`. A client string is **never** interpolated into
  an `<iframe src>` or an anchor `href`: that is how you get `javascript:` payloads, open
  redirects, and lookalike hosts (`youtube.com.evil.tld`) rendered as trusted.
- **Existence and embeddability are server-verified, not claimed.** The backend calls YouTube's
  free **oEmbed** endpoint and only accepts a `200`. A deleted, private, or embedding-disabled
  video is rejected at create time (§9) rather than becoming a dead player for viewers.
- **Media facts come from oEmbed, not the client.** `thumbnailUrl` is YouTube's, `videoSource` and
  `uploadStatus` are set by the server. A client that POSTs `durationSeconds: 5`, `uploadStatus`,
  or `youtubeVideoId` is rejected outright by `.strict()` (§7).
- **Gating a YouTube video is impossible — so the backend refuses to pretend.** The bytes live on
  youtube.com; anyone with the link watches them, signed in to Qatoto or not. Therefore
  `visibility: investor_only` or `isNdaRequired: true` on a `videoSource = "youtube"` row is
  **rejected with `422 GATING_UNSUPPORTED_FOR_SOURCE`**. `private` / `unlisted` are accepted but
  mean **Qatoto-surface visibility only** — they hide the row in Qatoto's own lists; they do
  **not** protect the video. Claiming otherwise in the UI would be a false security promise. The
  server-minted playback JWT returns with self-hosting ([Appendix A](#appendix-a--deferred-self-hosted-video-livepeer-direct-upload)) —
  the *principle* (gating is decided server-side, never self-issued by the client) is unchanged.
- **Publish is gated server-side.** "Save draft" vs "Publish" is UX; the server decides whether a
  video is *complete enough* to go live (title, `uploadStatus = ready`, a visibility tier) at
  `POST /videos/:id/publish`, and rejects with `422` otherwise.
- **Anime approval is server-side only.** An anime episode never self-publishes. On publish it
  goes to `reviewStatus: pending`; only a `moderator`/`admin` (role re-derived from the session,
  §10) can approve it into `/anime`. The client's "Save" is a submission, not an authorization.
- **Attached products/pitches are re-validated.** The client only sends ids; the backend
  re-confirms the caller owns each attached `product` (and the price/inventory shown to a buyer
  is always re-derived, never trusted from the video attachment — per STORE §0).
- **Validate the shape of every body/query** with Zod `.safeParse()` → `422` on failure, using
  `.strict()` to reject unknown keys (the prevailing controller style in this backend).

If you remember nothing else from this file, remember §0.

---

## 1. What the frontend expects

The creator surface is two pages plus a modal:

- **Upload landing** — a **YouTube URL field**
  ([create-studio-page.tsx](src/components/studio/pages/create-studio-page.tsx)): "Add a video
  from YouTube", validated live by `extractYoutubeVideoId`; **Add video** opens the modal. Below
  an "OR" divider sits the file dropzone, **`inert` and dimmed** — hosting is paused, the markup
  stays for Appendix A.
- **Upload modal** — a 4-step wizard
  ([upload-modal.tsx](src/components/studio/upload/upload-modal.tsx)): **Details → Video elements
  → Checks → Visibility**, reused in **create** and **edit** modes. It does **not** collect the
  video — the source arrives as a prop:
  `UploadSource = { kind: "file"; videoFile: File } | { kind: "youtube"; youtubeUrl: string }`.
  The right-side card renders a sandboxed `youtube-nocookie` iframe for the YouTube case
  ([video-preview-card.tsx](src/components/studio/upload/video-preview-card.tsx)); the
  "Processing video…" → player transition only applies to the paused file path.
- **My Videos** — the creator's list
  ([videos-list.tsx](src/components/studio/videos/videos-list.tsx)): each row shows thumbnail,
  title, visibility, date, and — for anime — a read-only review badge (Pending / Approved /
  Rejected + reason). Per-row **Edit** re-opens the modal.

The shared shape is `StudioVideo` in
[studio-videos-context.tsx](src/state/studio-videos-context.tsx) — every field below maps to a
column or child table in §4.

### Field mapping (form → contract)

| Frontend field (`StudioVideo`)                             | Backend field                                                  | Notes                                                    |
| ---------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| `youtubeUrl`                                               | `youtubeVideoId`                                               | the **11-char id**; parsed + oEmbed-verified server-side |
| *(implicit: `youtubeUrl === ""`)*                          | `videoSource` (enum)                                           | `youtube`\|`hosted` — explicit enum, not a sentinel      |
| `title`                                                    | `title`                                                        | 1–100 chars (modal shows a 0/100 counter)                |
| `description`                                              | `description`                                                  | nullable                                                 |
| `videoType`                                                | `videoType` (enum)                                             | `pitch`\|`demo`\|`update`\|`ama`\|`anime_episode`        |
| `stageBadge`                                               | `stageBadge` (enum)                                            | `idea`\|`mvp`\|`scaling`\|`shipped`                      |
| `sectorTags` (`string[]`)                                  | `sectorTags` (`text[]`)                                        | B2B discovery tags (replaces YouTube Category)           |
| `websiteUrl`                                               | `websiteUrl`                                                   | normalized + `rel="nofollow noopener"` server-side       |
| `callToActionLabel`                                        | `ctaLabel`                                                     | paired with `ctaUrl` (custom CTA button)                 |
| `linkedinUrl` / `xProfileUrl` / `contactEmail`             | same                                                           | structured social rows, not dumped in description        |
| `isMadeForKids`                                            | `isMadeForKids`                                                | required Yes/No                                          |
| `hasAgeRestriction`                                        | `hasAgeRestriction`                                            | advanced                                                 |
| `selectedPlaylistTitles`                                   | `playlist_item` rows                                           | playlist membership (§4)                                 |
| `chapters` (`VideoChapter[]`)                              | `video_chapter` rows                                           | manual chapters (§4, §6)                                 |
| `attachedProductIds`                                       | `video_attached_product` rows                                  | shoppable; ownership re-verified                         |
| `attachedPitchTitle` / `hasFundingCallToAction`            | `attachedPitchId` / `hasFundingCallToAction`                   | link fields; pitch/funding domains are separate docs     |
| `openRoles` / `teamMemberNames` / `collaboratorEmails`     | `video_open_role` / `video_team_member` / `video_collaborator` | recruit / credit / invite                                |
| `attachedDocumentNames` / `milestones` / `relatedVideoUrl` | `video_document` / `video_milestone` / `relatedVideoUrl`       | deck, roadmap, related video                             |
| "Show more" advanced fields                                | explicit columns + `settings` jsonb                            | see §4 (paid promotion, tags, license, comment prefs, …) |
| `visibility`                                               | `visibility` (enum)                                            | `private`\|`unlisted`\|`public`\|`investor_only`         |
| `isNdaRequired`                                            | `isNdaRequired`                                                | gate before playback (Investor-only)                     |
| `scheduledPublishDate`                                     | `scheduledPublishAt`                                           | schedule                                                 |
| `fileName` / `fileSizeInBytes`                             | `originalFileName` / `sizeBytes`                               | both stay **`null`** for YouTube — see the trap below    |
| `animeEpisodeDetails`                                      | `anime_series` / `anime_season` / `anime_episode` rows         | anime branch (§4, §10)                                   |
| `status` (`StudioVideoStatus`)                             | `uploadStatus` + `publishStatus` + `reviewStatus`              | **one loose status → three orthogonal columns** (§4)     |

**Status contract:** the frontend's single `StudioVideoStatus` union
(`processing`\|`draft`\|`scheduled`\|`published`\|`pending-review`\|`approved`\|`rejected`) is a
**view** derived on read from three independent server columns — mixing them into one field on the
wire allows illegal states (e.g. "published" while still "processing"). See §4 and §8. For a
YouTube row `uploadStatus` is **`ready` from the moment it is created** — `uploading` and
`processing` never occur, so the `processing` badge is unreachable.

**Why `videoSource` is an enum, not an empty string.** The frontend today infers the source from
`youtubeUrl === ""` — a sentinel, which is exactly the loose-state modelling CLAUDE.md Pattern 1
forbids ("" is also what an unset field looks like, so "no source yet" and "hosted by Qatoto"
are indistinguishable). The backend stores an explicit `videoSource` enum and returns it on every
projection, so the client branches on a real variant instead of a magic value. The existing
"YouTube" `SourceBadge` in [videos-list.tsx](src/components/studio/videos/videos-list.tsx) should
read `videoSource === "youtube"` once wired.

> **Trap — `fileName` currently holds the URL.** `createDraftFromSource` in
> [upload-modal.tsx](src/components/studio/upload/upload-modal.tsx) builds a YouTube draft as
> `{ ...createEmptyUploadDraft(source.youtubeUrl, 0), youtubeUrl: source.youtubeUrl }` — so
> `fileName` is set to **the YouTube URL** and `fileSizeInBytes` to `0`. That is a frontend
> placeholder, not contract. The backend **must not persist it**: when `videoSource = "youtube"`,
> `originalFileName` and `sizeBytes` stay `null`, and the client-sent values are ignored. (It also
> means My Videos currently prints the raw URL as its secondary line — a frontend follow-up, §12.)

---

## 2. The stack

Everything the store/auth features use is reused. Video adds **no** paid integration at all.

| Concern           | Pick                                                    | Why / reuse                                                                      |
| ----------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Server framework  | **Express 5**                                           | Same app, more routers (`/videos`, `/playlists`, `/series`, `/admin`).           |
| Language          | **TypeScript** (strict, ESM `#src/*`)                   | Shared shapes with the frontend.                                                 |
| Database ORM      | **Drizzle ORM**                                         | New tables in `src/db/schema.ts`; `pnpm db:generate && db:migrate`.              |
| Database          | **PostgreSQL** via `pg`                                 | FKs, enums, unique/position indexes enforced at the DB.                          |
| Validation        | **zod**                                                 | Inline `.safeParse()` → `422` (prevailing style).                                |
| Video source      | **YouTube link** (`src/lib/youtube.ts`)                 | Parse URL → id; verify via free **oEmbed** with plain `fetch`. No key, no quota. |
| Video storage/CDN | **none — YouTube serves it**                            | We store an id. Playback is a `youtube-nocookie.com/embed/<id>` iframe (§5).     |
| Thumbnails        | **oEmbed `thumbnail_url`**, or **Cloudinary + sharp**   | Default is YouTube's, free. Custom upload reuses the product-image pipeline.     |
| Doc uploads (PDF) | **Cloudinary raw**                                      | Pitch deck / whitepaper; small, cheap.                                           |
| File uploads      | **multer** (`src/middleware/upload-*.ts`)               | Thumbnail/PDF **only** — there is no video file anywhere in this design.         |
| Rate limiting     | **express-rate-limit** (`src/middleware/rate-limit.ts`) | Per-route limiter on create + thumbnail + review actions.                        |

**New dependency: none — on either side.** The oEmbed check is one `fetch`. The frontend needs no
upload client (`tus-js-client` is Appendix A only). **No `@aws-sdk`, no `ffmpeg`, no video SDK.**

**New env** (backend):

```text
INITIAL_ADMIN_EMAIL=...                  # first-admin seed (§10)
INITIAL_ADMIN_PASSWORD=...
YOUTUBE_OEMBED_TIMEOUT_MS=3000           # optional; bound the verify call (§9)
```

> **The `LIVEPEER_*` vars already in `.env.example` stay unused.** Leave them, ignore them — they
> belong to [Appendix A](#appendix-a--deferred-self-hosted-video-livepeer-direct-upload). Nothing
> in §0–§13 reads them.

---

## 3. Folder structure (additions)

New and changed files, following the existing route → controller → service → db layering:

```text
qatoto-backend/
├── src/
│   ├── db/
│   │   └── schema.ts                       # + video + child tables + playlist/anime tables + enums + relations; + user.role
│   ├── routes/
│   │   ├── videos.routes.ts                # NEW — /videos CRUD, thumbnail, chapters, products, publish
│   │   ├── playlists.routes.ts             # NEW — /playlists CRUD + membership
│   │   ├── series.routes.ts                # NEW — /series (anime catalog) CRUD + seasons/episodes
│   │   └── admin.routes.ts                 # NEW — /admin/review queue (moderator/admin only)
│   ├── controllers/
│   │   ├── videos.controller.ts            # NEW — Zod parse + ownership guard + HTTP mapping
│   │   ├── playlists.controller.ts         # NEW
│   │   ├── series.controller.ts            # NEW
│   │   └── admin-review.controller.ts      # NEW
│   ├── services/
│   │   ├── videos.service.ts               # NEW — domain logic, returns Result<T, VideoError>
│   │   ├── playlists.service.ts            # NEW
│   │   ├── series.service.ts               # NEW
│   │   └── review.service.ts               # NEW — approve/reject + audit log
│   ├── middleware/
│   │   ├── require-role.ts                 # NEW — requireRole("moderator"|"admin"), role from session
│   │   └── upload-image.ts                 # reuse upload-product-image for thumbnails
│   ├── lib/
│   │   ├── youtube.ts                      # NEW — extractYoutubeVideoId + verifyYoutubeVideo (oEmbed) + buildYoutubeEmbedUrl
│   │   ├── cloudinary.ts                   # + uploadVideoThumbnail / deleteVideoThumbnail
│   │   └── image.ts                         # (reused) validateAndNormalizeImage
│   ├── scripts/
│   │   └── seed-admin.ts                    # NEW — first-admin seed from env (§10)
│   └── app.ts                               # + mount the new routers
```

**`src/lib/youtube.ts` is the backend twin of the frontend's
[src/lib/youtube.ts](src/lib/youtube.ts) — mirror it, don't diverge.** Same hostname allowlist
(`youtube.com` + `www.`/`m.`/`music.`, `youtu.be`, `youtube-nocookie.com`), same five accepted URL
shapes (`?v=`, `youtu.be/<id>`, `/embed/<id>`, `/shorts/<id>`, `/live/<id>` and `/v/<id>`, plus a
bare 11-char id), same `buildYoutubeEmbedUrl` output. It adds one function the frontend has no
business doing — `verifyYoutubeVideo(videoId)`, the oEmbed call (§9). The two copies must agree:
if the frontend accepts a URL the backend rejects, the creator gets a confusing `422` after a
green checkmark.

> **Not here, on purpose:** `webhooks.routes.ts`, `webhooks.controller.ts`, `lib/videoProvider.ts`,
> `lib/livepeer.ts`. All four are
> [Appendix A](#appendix-a--deferred-self-hosted-video-livepeer-direct-upload). There is no webhook
> router to mount, because nothing calls us back.

`req.user` is already attached by `requireAuth` (`src/middleware/require-auth.ts`) and typed via
`src/types/express.d.ts`. `requireRole` (§10) extends it to read `req.user.role`.

---

## 4. The data (new tables)

All in `src/db/schema.ts`, following the repo conventions used by the commerce tables:
`pgTable("snake_case", { camelColumn: type("snake_case_col") })`; self-generated ids
`text("id").primaryKey().$defaultFn(() => randomUUID())` (Better Auth never touches these);
timestamps `createdAt: timestamp("created_at").defaultNow().notNull()` and
`updatedAt … $onUpdate(() => new Date()).notNull()`; FKs `.references(() => …, { onDelete:
"cascade" })`; indexes in the 3rd `pgTable` arg; `relations(...)` declared separately.

### Two-axis status model (no loose UI states)

The frontend's one `status` field is **three orthogonal server columns** so illegal combinations
can't exist (Pattern 1, CLAUDE.md):

- `uploadStatus` — the **media** lifecycle. For a **YouTube** row it is set to **`ready` at create
  time** and only ever moves to `failed` (if a later re-check finds the video deleted or made
  private, §5). The `uploading` → `processing` transitions belong to the deferred hosted path and
  never occur today. The client never sets this.
- `publishStatus` — the **distribution** state the creator controls: `draft` → `scheduled` →
  `published`.
- `reviewStatus` — the **moderation** state for gated content: `not_required` (normal videos) /
  `pending` / `approved` / `rejected`. Defaults to `not_required`; set to `pending` when
  `videoType = anime_episode` on publish.

A row can be `uploadStatus: ready` **and** `publishStatus: draft` **and** `reviewStatus:
not_required` simultaneously — all independent. The frontend badge is derived from the three (§8).

### Enums

```ts
// Where the bytes live. "youtube" is the only value produced today; "hosted" exists so the
// deferred self-hosting path (Appendix A) is an insert, not a migration.
export const videoSourceEnum = pgEnum("video_source", ["youtube", "hosted"]);

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
    "anime_episode",
]);

export const videoStageEnum = pgEnum("video_stage", ["idea", "mvp", "scaling", "shipped"]);

// Media lifecycle — server-set, never the client. YouTube rows start at "ready";
// "uploading"/"processing" are reserved for the deferred hosted path (Appendix A).
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

export const contentReviewStatusEnum = pgEnum("content_review_status", [
    "not_required",
    "pending",
    "approved",
    "rejected",
]);

export const videoLicenseEnum = pgEnum("video_license", ["standard", "creative_commons"]);

export const shortsRemixEnum = pgEnum("shorts_remix", ["video_and_audio", "audio_only"]);

export const playlistVisibilityEnum = pgEnum("playlist_visibility", [
    "public",
    "unlisted",
    "private",
]);

export const animeAudioModeEnum = pgEnum("anime_audio_mode", ["subbed", "dubbed"]);

// Which provider stored the asset — keeps mixed/migrated assets coexisting (§5.1).
export const storageProviderEnum = pgEnum("storage_provider", [
    "livepeer",
    "cloudflare",
    "imagekit",
    "self_hosted",
]);

// RBAC — added to the auth `user` table (§10).
export const userRoleEnum = pgEnum("user_role", ["user", "moderator", "admin"]);
```

### `video`

The record, owned by exactly one creator. **Provider columns are neutral** (`videoAssetId`, not
`livepeerAssetId`) and, today, **entirely unused** — they exist so the deferred hosted path
(Appendix A) is an insert rather than a migration (§5.1).

```ts
export const video = pgTable(
    "video",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => randomUUID()),
        // Owner. Stamped from req.user.id at create — NEVER from the body (§0).
        creatorId: text("creator_id")
            .notNull()
            .references(() => user.id, { onDelete: "cascade" }),

        // --- Where the video lives ---
        videoSource: videoSourceEnum("video_source").default("youtube").notNull(),
        // The 11-char YouTube id — NEVER the raw client URL (§0). Null when videoSource="hosted".
        // Embed URLs are rebuilt server-side as youtube-nocookie.com/embed/<id>.
        youtubeVideoId: text("youtube_video_id"),

        // --- Provider-neutral media identity — ALL NULL TODAY (Appendix A) ---
        // Nullable and unused while videoSource="youtube". Kept so self-hosting is an insert,
        // not a migration. Do not populate these from the YouTube path.
        storageProvider: storageProviderEnum("storage_provider"),
        videoAssetId: text("video_asset_id"),
        playbackId: text("playback_id"),
        playbackUrl: text("playback_url"),

        // Server-set. "ready" immediately for YouTube; "failed" if a re-check finds it gone (§5).
        uploadStatus: videoUploadStatusEnum("upload_status").default("ready").notNull(),
        // Null for YouTube — oEmbed does not return duration (see the chapters note below).
        durationSeconds: integer("duration_seconds"),
        // Both null for YouTube. The frontend's placeholder values are discarded (§1 trap).
        sizeBytes: integer("size_bytes"),
        originalFileName: text("original_file_name"),
        // YouTube's oEmbed thumbnail_url by default, OR a Cloudinary custom thumbnail (§8).
        thumbnailUrl: text("thumbnail_url"),

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
        isMadeForKids: boolean("is_made_for_kids"),
        hasAgeRestriction: boolean("has_age_restriction").default(false).notNull(),

        // --- Video elements step (scalar links; list attachments are child tables below) ---
        relatedVideoUrl: text("related_video_url"),
        attachedPitchId: text("attached_pitch_id"), // FK to a future pitch table (§12)
        hasFundingCallToAction: boolean("has_funding_cta").default(false).notNull(),

        // --- Visibility step ---
        visibility: videoVisibilityEnum("visibility").default("private").notNull(),
        isNdaRequired: boolean("is_nda_required").default(false).notNull(),
        scheduledPublishAt: timestamp("scheduled_publish_at"),

        // --- Orthogonal status columns (see "Two-axis status model") ---
        publishStatus: videoPublishStatusEnum("publish_status").default("draft").notNull(),
        publishedAt: timestamp("published_at"),
        reviewStatus: contentReviewStatusEnum("review_status").default("not_required").notNull(),
        rejectionReason: text("rejection_reason"),

        // --- "Show more" first-class advanced fields ---
        license: videoLicenseEnum("license").default("standard").notNull(),
        tags: text("tags").array().notNull().default([]),
        videoLanguage: text("video_language"),
        isEmbeddingAllowed: boolean("is_embedding_allowed").default(true).notNull(),
        areCommentsEnabled: boolean("are_comments_enabled").default(true).notNull(),
        shouldShowLikesCount: boolean("should_show_likes_count").default(true).notNull(),
        hasPaidPromotion: boolean("has_paid_promotion").default(false).notNull(),
        usesAlteredContent: boolean("uses_altered_content"),

        // Long-tail "show more" prefs with no query/relationship value:
        // captionCertification, commentModeration, commentSortOrder, shortsRemixing,
        // recordingDate, recordingLocation, category. A jsonb keeps the table sane;
        // promote any field to a column if it ever needs an index or FK.
        settings: jsonb("settings").notNull().default({}),

        createdAt: timestamp("created_at").defaultNow().notNull(),
        updatedAt: timestamp("updated_at")
            .defaultNow()
            .$onUpdate(() => new Date())
            .notNull(),
    },
    (table) => [
        index("video_creatorId_idx").on(table.creatorId),
        index("video_publishStatus_idx").on(table.publishStatus),
        index("video_reviewStatus_idx").on(table.reviewStatus),
        index("video_videoType_idx").on(table.videoType),
        index("video_youtubeVideoId_idx").on(table.youtubeVideoId),
        // One row per provider asset — partial, because every row is NULL here today.
        uniqueIndex("video_asset_unq")
            .on(table.videoAssetId)
            .where(sql`${table.videoAssetId} is not null`),
    ],
);
```

Two index decisions worth stating outright:

- **`youtubeVideoId` is indexed but NOT unique.** Two Qatoto entries may legitimately point at
  the same YouTube video — a creator re-listing a demo under a new pitch, or two founders of the
  same company each linking the launch video. Deduplicating would reject valid work. If abuse
  shows up (one account spamming the feed with one video), rate-limit `POST /videos` (§2) rather
  than adding a unique constraint that also blocks the honest cases.
- **`video_asset_unq` must be partial.** Postgres treats `NULL`s as distinct, so a plain unique
  index over an all-`NULL` column is harmless — but say it explicitly with a `WHERE … IS NOT NULL`
  so the intent survives the switch to self-hosting, when the column stops being all-`NULL`.

> **Why `settings` is jsonb, not columns.** The YouTube-carryover "show more" fields
> (caption certification, comment moderation mode, sort order, shorts-remix mode, recording
> date/location, category) are display prefs with no query, index, or FK need — mirroring the
> store doc's `keyFeatures` reasoning, but for a heterogeneous bag rather than an array. First-class
> fields that gate behavior (`visibility`, `license`, `areCommentsEnabled`) stay real columns.

### Child tables (one per repeating group)

```ts
// Manual chapters (chapters-editor.tsx). Rules validated in the service (§6).
export const videoChapter = pgTable(
    "video_chapter",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => randomUUID()),
        videoId: text("video_id")
            .notNull()
            .references(() => video.id, { onDelete: "cascade" }),
        startSeconds: integer("start_seconds").notNull(), // 0 for the first chapter
        title: text("title").notNull(),
        position: integer("position").notNull(),
        createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (table) => [index("video_chapter_videoId_idx").on(table.videoId)],
);

// Shoppable products (store-products-picker.tsx). Ownership of each product re-verified (§0).
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
        pinnedAtSeconds: integer("pinned_at_seconds"), // optional: pop the card at this timestamp
        createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (table) => [
        index("video_attached_product_videoId_idx").on(table.videoId),
        uniqueIndex("video_product_unq").on(table.videoId, table.productId),
    ],
);

// Pitch deck / whitepaper PDFs (Cloudinary raw or provider).
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

// Roadmap / build→ship milestones.
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

// Recruit: open roles attached to a video (applications = §12 gap).
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
        position: integer("position").notNull(),
        createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (table) => [index("video_open_role_videoId_idx").on(table.videoId)],
);

// Team credit shown on the watch page. linkedUserId ties a credit to a real account when known.
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

// Invite-collaborator: pending/accepted invites by email (or resolved user).
export const videoCollaborator = pgTable(
    "video_collaborator",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => randomUUID()),
        videoId: text("video_id")
            .notNull()
            .references(() => video.id, { onDelete: "cascade" }),
        invitedEmail: text("invited_email").notNull(),
        userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
        status: text("status").default("invited").notNull(), // invited | accepted | declined
        createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (table) => [index("video_collaborator_videoId_idx").on(table.videoId)],
);
```

### Playlists

```ts
export const playlist = pgTable(
    "playlist",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => randomUUID()),
        creatorId: text("creator_id")
            .notNull()
            .references(() => user.id, { onDelete: "cascade" }),
        title: text("title").notNull(),
        description: text("description"),
        visibility: playlistVisibilityEnum("visibility").default("private").notNull(),
        defaultVideoOrder: text("default_video_order").default("date_published_newest").notNull(),
        language: text("language"),
        createdAt: timestamp("created_at").defaultNow().notNull(),
        updatedAt: timestamp("updated_at")
            .defaultNow()
            .$onUpdate(() => new Date())
            .notNull(),
    },
    (table) => [index("playlist_creatorId_idx").on(table.creatorId)],
);

export const playlistItem = pgTable(
    "playlist_item",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => randomUUID()),
        playlistId: text("playlist_id")
            .notNull()
            .references(() => playlist.id, { onDelete: "cascade" }),
        videoId: text("video_id")
            .notNull()
            .references(() => video.id, { onDelete: "cascade" }),
        position: integer("position").notNull(),
        createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (table) => [
        index("playlist_item_playlistId_idx").on(table.playlistId),
        uniqueIndex("playlist_item_unq").on(table.playlistId, table.videoId),
    ],
);
```

### Anime catalog (series → season → episode)

An anime episode is created **through the upload flow** (`videoType = anime_episode`): the modal
either picks an existing series or creates one, and on save the service creates/links the
`anime_series` / `anime_season` / `anime_episode` rows to the new `video` row and sets the video's
`reviewStatus: pending`. The catalog is also editable at `/studio/series`.

```ts
export const animeSeries = pgTable(
    "anime_series",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => randomUUID()),
        ownerId: text("owner_id")
            .notNull()
            .references(() => user.id, { onDelete: "cascade" }),
        title: text("title").notNull(),
        description: text("description"),
        posterUrl: text("poster_url"),
        genreTags: text("genre_tags").array().notNull().default([]),
        status: text("status").default("ongoing").notNull(), // ongoing | completed | hiatus
        createdAt: timestamp("created_at").defaultNow().notNull(),
        updatedAt: timestamp("updated_at")
            .defaultNow()
            .$onUpdate(() => new Date())
            .notNull(),
    },
    (table) => [index("anime_series_ownerId_idx").on(table.ownerId)],
);

export const animeSeason = pgTable(
    "anime_season",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => randomUUID()),
        seriesId: text("series_id")
            .notNull()
            .references(() => animeSeries.id, { onDelete: "cascade" }),
        seasonLabel: text("season_label").notNull(),
        position: integer("position").notNull(),
        createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (table) => [index("anime_season_seriesId_idx").on(table.seriesId)],
);

export const animeEpisode = pgTable(
    "anime_episode",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => randomUUID()),
        seasonId: text("season_id")
            .notNull()
            .references(() => animeSeason.id, { onDelete: "cascade" }),
        // The uploaded asset. One video is at most one episode.
        videoId: text("video_id").references(() => video.id, { onDelete: "set null" }),
        episodeNumber: integer("episode_number").notNull(),
        episodeTitle: text("episode_title").notNull(),
        isPremium: boolean("is_premium").default(false).notNull(),
        releaseScheduleDay: text("release_schedule_day"), // e.g. "friday"
        releaseScheduleTime: text("release_schedule_time"), // e.g. "18:00"
        premiereDate: timestamp("premiere_date"),
        audioMode: animeAudioModeEnum("audio_mode"),
        audioLanguage: text("audio_language"),
        ageRating: text("age_rating"),
        releasedAt: timestamp("released_at"), // set when it goes live in /anime after approval
        createdAt: timestamp("created_at").defaultNow().notNull(),
        updatedAt: timestamp("updated_at")
            .defaultNow()
            .$onUpdate(() => new Date())
            .notNull(),
    },
    (table) => [
        index("anime_episode_seasonId_idx").on(table.seasonId),
        uniqueIndex("anime_episode_unq").on(table.seasonId, table.episodeNumber),
    ],
);
```

### Content-review audit log

Every approve/reject is logged (admin doc §6 "build mock audit log now" → real table here). Maps
to the frontend `admin-audit-log-context`.

```ts
export const contentReviewAction = pgTable(
    "content_review_action",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => randomUUID()),
        videoId: text("video_id")
            .notNull()
            .references(() => video.id, { onDelete: "cascade" }),
        reviewerId: text("reviewer_id")
            .notNull()
            .references(() => user.id, { onDelete: "cascade" }),
        action: text("action").notNull(), // approve | reject
        reason: text("reason"),
        createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (table) => [index("content_review_action_videoId_idx").on(table.videoId)],
);
```

### `user.role` (RBAC)

Add a `role` column to the existing auth `user` table (Better Auth `additionalFields` /
migration):

```ts
// in the existing `user` pgTable definition:
role: userRoleEnum("role").default("user").notNull(),
```

### Relations

Declare `relations(...)` for `video` (→ creator, chapters, attachedProducts, documents,
milestones, openRoles, teamMembers, collaborators, animeEpisode), `playlist` (→ items),
`animeSeries`/`animeSeason`/`animeEpisode`, and `contentReviewAction` — same pattern as
`productRelations` in STORE §4. After editing `schema.ts`, run `pnpm db:generate && pnpm
db:migrate`.

---

## 5. The cost architecture (why this is zero cost — and what it costs you instead)

Video is the expensive media type, which is exactly why the first version of this doc built an
elaborate machine to make it cheap. The YouTube-link path skips the machine: **there is no video
infrastructure to be cheap about.**

1. **No bytes anywhere.** Not through Express, not to a provider we pay, not into a bucket. The
   creator's file never leaves YouTube, where it already is. We persist an **11-character
   string**. There is no egress, no proxy bandwidth, no multi-GB buffer, no long-held request.

2. **No transcode, no HLS, no CDN, no storage line item.** YouTube already did all of it, for
   free, before the creator ever pasted the link. We run no `ffmpeg`, rent no GPU, and buy no
   delivery minutes. This is the single biggest cost in any video product, and it is **$0**.

3. **Playback is an iframe.** The client renders
   `https://www.youtube-nocookie.com/embed/<id>` — built server-side from the stored id (§0).
   Our servers are not in the playback path at all. `-nocookie` keeps YouTube from setting
   tracking cookies until the viewer actually plays, which is the friendlier default.

4. **Thumbnails are free too.** oEmbed hands back a `thumbnail_url` at create time; store it.
   A **custom** thumbnail still reuses the existing **Cloudinary + sharp** pipeline — tiny images
   on a free tier — but the default costs nothing and no upload happens.

5. **One small `fetch` per create.** The oEmbed verify needs **no API key and has no quota** (it
   is not the YouTube Data API). Bound it with `YOUTUBE_OEMBED_TIMEOUT_MS` and cache the result
   briefly so a retrying client doesn't hammer it.

6. **Postgres stores ids + metadata.** Kilobytes per video, not gigabytes. No blob columns.

**Net: video adds nothing to the bill.** Not "nearly nothing at low volume, usage-based after" —
nothing, at any volume.

### 5.1 What this actually costs (read before assuming it's free)

The price isn't money, it's control. All four of these are real, and none are fixable inside this
design — they are the reason [Appendix A](#appendix-a--deferred-self-hosted-video-livepeer-direct-upload)
still exists:

- **No gating. At all.** The video is public on youtube.com. `investor_only` and NDA-gated
  playback are **impossible**, which is why the backend rejects them (`422
  GATING_UNSUPPORTED_FOR_SOURCE`, §0/§6) instead of implying protection it can't deliver.
  `private`/`unlisted` hide the Qatoto row, nothing more. **If confidential pitch video is a
  product requirement, this design does not meet it** — that requirement is what unblocks
  Appendix A.
- **YouTube's chrome, in our product.** Its branding, its "watch on YouTube" affordance, and its
  related-video suggestions at the end — including competitors'. `modestbranding` and `rel=0` no
  longer do what people think they do.
- **The creator can pull the video out from under us.** They can delete it, set it private, or
  disable embedding on youtube.com at any moment, and Qatoto finds out only by asking.
  **Mitigation:** a periodic re-check job re-runs the oEmbed call over published rows and flips
  `uploadStatus: "failed"` when a video stops resolving, so the row shows as broken to its
  creator instead of showing a dead player to viewers. Cheap (one HEAD-ish JSON call per row,
  spread out); worth building alongside the create path.
- **No watch analytics of our own.** Views, watch-time, and drop-off live in the creator's
  YouTube Studio, not ours. Anything Qatoto wants to rank or reward on ("proof of effort", feed
  ordering) cannot use watch data while the video is hosted elsewhere.

Also worth pricing in: **an oEmbed outage or a network blip fails video creation** (`502
YOUTUBE_VERIFY_FAILED`, §6). That's the correct trade — better to reject than to store an
unverified id — but it means create has an external dependency that the deferred hosted path
would not.

### 5.2 Why the provider seam still matters

The `videoProvider` interface, the neutral columns, and the `videoSource` enum are **not dead
weight** — they are what makes the eventual switch cheap. The design rule holds in both
directions:

- **The frontend never names the source.** It calls our `/videos` endpoints and renders whatever
  playback shape the projection tells it to. When hosting lands, `videoSource: "hosted"` rows
  start arriving and the client branches — no rewrite.
- **`videoAssetId` / `playbackId` / `playbackUrl` / `storageProvider` are already in the table,
  nullable.** Populating them later is an `UPDATE`, not a migration. **No table drop, no rename.**
- **Both sources coexist.** A `hosted` row and a `youtube` row can sit side by side in the same
  list forever; nothing forces a backfill.

The full seam — the `VideoProvider` interface, the TUS/PUT protocol tagging, and the
Cloudflare Stream / ImageKit / Hetzner comparison — lives in
[Appendix A](#appendix-a--deferred-self-hosted-video-livepeer-direct-upload). **Do not implement
it now.**

---

## 6. The API — endpoints YOU write

Mounted in `src/app.ts` after `express.json()` — all four are ordinary JSON routers. **There is no
webhook router**: nothing calls us back, because nothing is processing anything.

```ts
app.use("/videos", videosRouter);
app.use("/playlists", playlistsRouter);
app.use("/series", seriesRouter);
app.use("/admin", adminRouter);
```

**Every** creator route is guarded by `requireAuth`; the creator id is `req.user.id`. Every
`/:id*` route runs the ownership check (§0) → `404` when the caller doesn't own the row. Declare
literal segments (`/mine`) **before** `/:id` (same rule as the users/products routers).

### Creator video (`/videos`)

| Method & path                    | Body / input                                           | Behavior & statuses                                                                                                                                                                                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /videos`                   | JSON `CreateVideoSchema` (**`youtubeUrl`** + metadata) | Parse → oEmbed verify → create the row at `videoSource: "youtube"`, `uploadStatus: "ready"`, `thumbnailUrl` from oEmbed. `201 { video: PublicVideo, suggestedTitle }` — **no `upload` object**. `422 INVALID_YOUTUBE_URL` · `422 YOUTUBE_VIDEO_UNAVAILABLE` · `422 GATING_UNSUPPORTED_FOR_SOURCE` · `502 YOUTUBE_VERIFY_FAILED`. |
| `GET /videos/mine`               | `?page&limit`                                          | Caller's own videos, `PaginatedResponse<VideoListRow>` ordered by `updatedAt` desc. `200`.                                                                                                                                                                                                                                       |
| `GET /videos/:id`                | —                                                      | Full `PublicVideo` (chapters, products, attachments, anime). Owner only → `404` otherwise.                                                                                                                                                                                                                                       |
| `PATCH /videos/:id`              | JSON `UpdateVideoSchema` (all optional)                | Partial update of mutable metadata. A changed `youtubeUrl` is **re-parsed and re-verified** exactly like create. `200 PublicVideo` · same YouTube statuses as `POST` · `422` · `404`.                                                                                                                                            |
| `POST /videos/:id/thumbnail`     | `multipart/form-data`, field **`image`**               | sharp validate+normalize → Cloudinary → overwrite the oEmbed `thumbnailUrl`. `200` · image statuses (§8 map) · `413` (>5 MB) · `404`.                                                                                                                                                                                            |
| `PUT /videos/:id/chapters`       | JSON `{ chapters: [{ startSeconds, title }] }`         | Replace the chapter set. Validate: first `startSeconds = 0`, strictly ascending, ≥10 s apart, ≥3 to show. The `≤ durationSeconds` bound is **skipped for YouTube rows** (see below). `200` · `422` · `404`.                                                                                                                      |
| `PUT /videos/:id/products`       | JSON `{ productIds: string[] }`                        | Replace attached products; **each product ownership re-verified** → `422 PRODUCT_NOT_OWNED`. `200` · `404`.                                                                                                                                                                                                                      |
| `PUT /videos/:id/playlists`      | JSON `{ playlistIds: string[] }`                       | Set which of the caller's playlists contain this video. `200` · `404`.                                                                                                                                                                                                                                                           |
| `POST /videos/:id/publish`       | —                                                      | draft → published (or `scheduled` if `scheduledPublishAt` is future). Re-check completeness + re-reject gated tiers. **anime → `reviewStatus: pending`, NOT live.** `200 PublicVideo` · `422 INCOMPLETE_FOR_PUBLISH` · `422 GATING_UNSUPPORTED_FOR_SOURCE` · `404`.                                                              |
| `POST /videos/:id/unpublish`     | —                                                      | published/scheduled → draft. `200` · `404`.                                                                                                                                                                                                                                                                                      |
| `GET /videos/:id/playback-token` | —                                                      | **Deferred.** A YouTube video cannot be gated, so this always returns `409 NO_TOKEN_REQUIRED` today. The real implementation is [Appendix A](#appendix-a--deferred-self-hosted-video-livepeer-direct-upload). Keep the route so the client contract doesn't move later.                                                          |
| `DELETE /videos/:id`             | —                                                      | Delete the Cloudinary custom thumbnail if there is one, then the row (FK cascade clears children). **No provider asset to delete** — the YouTube video isn't ours. `200` · `404`.                                                                                                                                                |

**The `≤ durationSeconds` chapter bound is dropped for YouTube.** oEmbed does not return a
duration, so `durationSeconds` is `null` on every YouTube row (§4) and there is nothing to compare
against. The other chapter rules — first chapter at `0`, strictly ascending, ≥10 s apart, ≥3 to
render — still hold and are still enforced in the service. The alternative, calling the **YouTube
Data API v3** (`videos.list?part=contentDetails`) for a real duration, is **not adopted**: it
needs an API key and a daily quota, which trades away the no-key/no-quota property that makes this
design cost nothing. Revisit only if chapters past the end turn out to be a real problem in
practice.

**`suggestedTitle`** on the create response is the oEmbed title, offered so the modal can prefill
an empty title field. It is a **suggestion, not the stored value** — whatever the creator typed
wins, and the server never overwrites a non-empty `title` with it.

### Playlists (`/playlists`)

`POST /playlists` (create) · `GET /playlists/mine` (list) · `PATCH /playlists/:id` (rename/visibility)
· `DELETE /playlists/:id` · `PUT /playlists/:id/videos` (`{ videoIds: string[] }` — membership +
order). All `requireAuth`, owner-scoped, `404` on non-owner.

### Anime catalog (`/series`)

`POST /series` · `GET /series/mine` · `GET /series/:id` · `PATCH /series/:id` · `DELETE /series/:id`,
with nested `POST /series/:id/seasons` and `POST /seasons/:id/episodes`. Owner-scoped. (Episodes are
normally created via the upload flow; these exist for catalog management at `/studio/series`.)

### No webhook endpoint

The old `POST /webhooks/livepeer` route is **deleted from the active spec** — there is no
transcode to be notified about, and readiness is decided synchronously at create time. It is
preserved in [Appendix A](#appendix-a--deferred-self-hosted-video-livepeer-direct-upload) for the
hosted path. Do not mount a webhook router, and do not add a raw-body parser for one.

### Admin review (`/admin/review`, `requireRole("moderator")`)

| Method & path                         | Behavior & statuses                                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /admin/review?status=pending`    | List videos where `videoType = anime_episode` and `reviewStatus = <status>`. `200 PaginatedResponse<ReviewRow>`. `403` if caller lacks role.                                                     |
| `POST /admin/review/:videoId/approve` | `reviewStatus: approved`; **auto-publish** to `/anime` on/after the episode release date (admin decision #3), set `animeEpisode.releasedAt`; log `content_review_action`. `200` · `403` · `404`. |
| `POST /admin/review/:videoId/reject`  | JSON `{ reason }` → `reviewStatus: rejected` + `rejectionReason`; log action. `200` · `403` · `404` · `422`.                                                                                     |

Role is **re-derived from the session** in `requireRole` (§10) — a client-claimed role is ignored.

---

## 7. Validation (`src/controllers/*.controller.ts`)

Inline Zod at the top of each controller, `Schema.safeParse(req.body)`, `422` +
`z.flattenError(parsed.error).fieldErrors` — the prevailing style. `.strict()` rejects unknown keys.
Sketch for the video create/update:

```ts
const ChapterSchema = z.object({
    startSeconds: z.number().int().min(0),
    title: z.string().trim().min(1).max(120),
});

const CreateVideoSchema = z
    .object({
        // The video source. Shape-checked here; the id is extracted and the video is
        // verified against oEmbed in the service (§9).
        youtubeUrl: z
            .string()
            .trim()
            .url()
            .max(2048)
            .refine(isYoutubeVideoUrl, "Not a YouTube video link"),
        title: z.string().trim().min(1).max(100),
        description: z.string().trim().max(5000).optional(),
        videoType: z.enum(["pitch", "demo", "update", "ama", "anime_episode"]).default("demo"),
        stageBadge: z.enum(["idea", "mvp", "scaling", "shipped"]).optional(),
        sectorTags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
        websiteUrl: z.string().url().max(2048).optional(),
        ctaLabel: z.string().trim().max(60).optional(),
        ctaUrl: z.string().url().max(2048).optional(),
        linkedinUrl: z.string().url().max(2048).optional(),
        xProfileUrl: z.string().url().max(2048).optional(),
        contactEmail: z.string().email().optional(),
        isMadeForKids: z.boolean().optional(),
        visibility: z.enum(["private", "unlisted", "public", "investor_only"]).default("private"),
        isNdaRequired: z.boolean().default(false),
        scheduledPublishAt: z.coerce.date().optional(),
        originalFileName: z.string().trim().max(255).optional(),
        // anime branch (required only when videoType === "anime_episode"; enforce with .refine)
        anime: z
            .object({
                seriesId: z.string().optional(), // omit to create a new series
                newSeriesTitle: z.string().trim().max(200).optional(),
                seasonLabel: z.string().trim().max(60),
                episodeNumber: z.number().int().min(0),
                episodeTitle: z.string().trim().min(1).max(200),
                releaseScheduleDay: z.string().optional(),
                releaseScheduleTime: z.string().optional(),
                premiereDate: z.coerce.date().optional(),
                audioMode: z.enum(["subbed", "dubbed"]).optional(),
                audioLanguage: z.string().optional(),
                ageRating: z.string().optional(),
                genreTags: z.array(z.string()).max(20).default([]),
            })
            .optional(),
    })
    .strict();

const UpdateVideoSchema = CreateVideoSchema.partial();
const ReplaceChaptersSchema = z.object({ chapters: z.array(ChapterSchema).max(100) }).strict();
const ReplaceProductsSchema = z.object({ productIds: z.array(z.string()).max(50) }).strict();
```

Notes the doc pins down:

- **Media fields are never in the schema.** `youtubeVideoId`, `videoSource`, `uploadStatus`,
  `thumbnailUrl`, `durationSeconds`, `sizeBytes`, `originalFileName`, `playbackId`,
  `videoAssetId` are all **server-derived** — a client that sends them is rejected by `.strict()`.
  Note this includes `youtubeVideoId`: the client sends a **URL**, the server decides the **id**.
- **`isYoutubeVideoUrl` is a shape check, not proof the video exists.** A perfectly-formed link to
  a deleted video passes Zod and fails at the oEmbed step in the service (§9). Both layers are
  needed — don't collapse them.
- **The gated-tier rejection lives in the service, not the schema.** `visibility: "investor_only"`
  and `isNdaRequired: true` are individually valid; they're only illegal *in combination with*
  `videoSource = "youtube"`. That's a cross-field rule over persisted state, so it belongs where
  the source is known — enforced on create, on `PATCH`, and again on publish, because a row can
  be created `public` and edited toward `investor_only` later.
- **URLs are validated + normalized server-side** and rendered `rel="nofollow noopener"` (§0);
  don't trust a client-claimed "verified" state.
- **Chapter rules** (first `0`, ascending, ≥10 s apart, ≥3 to show) are enforced in the service,
  not just the schema. The `≤ durationSeconds` bound is skipped for YouTube rows, where duration
  is unknown (§6).
- **Publish/unpublish/thumbnail/playback-token** take **no mutation body** (or only `reason` for
  reject); their inputs are the session + path params.

---

## 8. Services & Result types (`src/services/*.service.ts`)

Services never touch `req`/`res`; they return `Result<T, VideoError>` and the controller
exhaustively switches on `error.type` → HTTP (with a `never` default), exactly like
`users.service.ts` / `products.service.ts`.

```ts
export type VideoError =
    | { type: "NOT_FOUND"; videoId: string } // missing OR not owned → 404
    | { type: "INCOMPLETE_FOR_PUBLISH"; missing: string[] } // publish gate → 422
    | { type: "NOT_READY"; uploadStatus: string } // publish before ready → 422
    | { type: "PRODUCT_NOT_OWNED"; productId: string } // attach a stranger's product → 422
    | { type: "INVALID_CHAPTERS"; message: string } // chapter rules → 422
    | { type: "NO_TOKEN_REQUIRED" } // playback-token on a YouTube row → 409
    | { type: "NOT_PERMITTED" } // gated playback, caller not allowed → 403
    // --- YouTube source ---
    | { type: "INVALID_YOUTUBE_URL" } // no id could be extracted → 422
    | { type: "YOUTUBE_VIDEO_UNAVAILABLE"; youtubeVideoId: string } // deleted/private/no-embed → 422
    | { type: "YOUTUBE_VERIFY_FAILED" } // oEmbed unreachable or timed out → 502
    | { type: "GATING_UNSUPPORTED_FOR_SOURCE"; videoSource: string } // investor_only/NDA on youtube → 422
    | ImageValidationError // reused from lib/image.ts (sharp) — thumbnail route
    | CloudinaryError; // reused from lib/cloudinary.ts — thumbnail route
```

`ProviderError` is **not** in the active union — it belongs to
[Appendix A](#appendix-a--deferred-self-hosted-video-livepeer-direct-upload). Note the deliberate
split between `YOUTUBE_VIDEO_UNAVAILABLE` (`422` — the creator gave us a bad link, they must fix
it) and `YOUTUBE_VERIFY_FAILED` (`502` — YouTube didn't answer, not the creator's fault, retrying
may work). Collapsing them into one status would tell a creator to fix a link that was fine.

Canonical read-back projections (one source of truth for shape, like `PublicProduct`):

```ts
export interface PublicVideo {
    readonly id: string;
    readonly title: string;
    readonly description: string | null;
    readonly videoType: "pitch" | "demo" | "update" | "ama" | "anime_episode";
    readonly stageBadge: "idea" | "mvp" | "scaling" | "shipped" | null;
    // where the video lives
    readonly videoSource: "youtube" | "hosted";
    readonly youtubeVideoId: string | null;
    // Server-built embed URL — the client renders this, never a string it composed itself (§0).
    readonly youtubeEmbedUrl: string | null; // https://www.youtube-nocookie.com/embed/<id>
    // provider-neutral media identity — null while videoSource === "youtube" (Appendix A)
    readonly storageProvider: "livepeer" | "cloudflare" | "imagekit" | "self_hosted" | null;
    readonly playbackId: string | null;
    readonly playbackUrl: string | null;
    readonly uploadStatus: "uploading" | "processing" | "ready" | "failed";
    readonly durationSeconds: number | null; // always null for YouTube — oEmbed has no duration
    readonly thumbnailUrl: string | null;
    // distribution + moderation
    readonly visibility: "private" | "unlisted" | "public" | "investor_only";
    readonly publishStatus: "draft" | "scheduled" | "published";
    readonly publishedAt: Date | null;
    readonly reviewStatus: "not_required" | "pending" | "approved" | "rejected";
    readonly rejectionReason: string | null;
    // attachments
    readonly chapters: readonly { id: string; startSeconds: number; title: string }[];
    readonly attachedProducts: readonly { id: string; productId: string; position: number }[];
    // …milestones, openRoles, teamMembers, documents, collaborators, anime episode…
}

// Compact row for My Videos (maps 1:1 to videos-list.tsx).
export interface VideoListRow {
    readonly id: string;
    readonly title: string;
    readonly thumbnailUrl: string | null;
    // Drives the "YouTube" SourceBadge — an explicit variant, not a `youtubeUrl !== ""` sentinel.
    readonly videoSource: "youtube" | "hosted";
    readonly visibility: "private" | "unlisted" | "public" | "investor_only";
    readonly uploadStatus: "uploading" | "processing" | "ready" | "failed";
    readonly publishStatus: "draft" | "scheduled" | "published";
    readonly reviewStatus: "not_required" | "pending" | "approved" | "rejected";
    readonly createdAt: Date;
}
```

`videoSource` on `VideoListRow` is what the existing "YouTube" `SourceBadge` in
[videos-list.tsx](src/components/studio/videos/videos-list.tsx) should read once wired — it
currently infers from `youtubeUrl !== ""`.

**Deriving the frontend badge (§1 status contract).** The single `StudioVideoStatus` the UI shows
is computed from the three columns on read — the client never stores it:

```text
uploadStatus = failed                      → "failed"
uploadStatus in {uploading,processing}     → "processing"   (unreachable for YouTube rows)
reviewStatus = pending                     → "pending-review"
reviewStatus = rejected                    → "rejected"
reviewStatus = approved & not yet released → "approved"
publishStatus = scheduled                  → "scheduled"
publishStatus = published                  → "published"
else                                       → "draft"
```

Keep the `processing` branch even though a YouTube row can never hit it — it is reachable again
the moment hosted rows exist, and deleting it would make Appendix A a code change instead of a
config change. `failed` **is** reachable for YouTube: the re-check job (§5.1) sets it when a video
is deleted or made private on youtube.com after the fact.

Ownership is enforced **in the service**: every read/mutation filters
`where(and(eq(video.id, id), eq(video.creatorId, creatorId)))`; an empty result → `NOT_FOUND` →
`404` (never leaking existence). Create (video row + anime rows), chapter/product/playlist replace,
and publish run inside a transaction so children stay consistent with the parent.

**Thumbnail status map** — identical to the store image map: missing `req.file` → `422`,
`NOT_AN_IMAGE`/`UNSUPPORTED_FORMAT`/dimension errors → `422`, `NOT_CONFIGURED` → `503`,
`UPLOAD_FAILED`/`DELETE_FAILED` → `502`, size cap → `413` (in the multer middleware).

---

## 9. The YouTube pipeline (parse → verify → store → publish)

Three steps, all synchronous. There is no background job, no polling, no callback.

1. **Parse (`POST /videos`).** `extractYoutubeVideoId(youtubeUrl)` reduces the client string to an
   11-char id, rejecting anything whose hostname isn't on the allowlist. No id → `422
   INVALID_YOUTUBE_URL`. **This is a security boundary, not a convenience** (§0): everything
   downstream handles an id, never the client's string.

2. **Verify (oEmbed).** `verifyYoutubeVideo(videoId)` calls

    ```text
    GET https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=<id>
    ```

    Build that `url` parameter from the **parsed id**, not the raw input. Then:

    - **`200`** → the video exists, is public, and permits embedding. Take `thumbnail_url` and
      `title` from the payload. This is the only accepted outcome.
    - **`401` / `403` / `404`** → deleted, private, or embedding-disabled → `422
      YOUTUBE_VIDEO_UNAVAILABLE`. The creator must fix the link.
    - **timeout / network error / 5xx** → `502 YOUTUBE_VERIFY_FAILED`. Not the creator's fault;
      the client may retry. Bound the call with `YOUTUBE_OEMBED_TIMEOUT_MS` so a hanging request
      can't hold an Express worker.

    No API key, no quota, no billing — this is oEmbed, **not** the YouTube Data API.

3. **Store.** One insert: `videoSource: "youtube"`, `youtubeVideoId`, `uploadStatus: "ready"`,
   `thumbnailUrl` from oEmbed. `durationSeconds`, `sizeBytes`, `originalFileName`, and every
   provider column stay `null`. The oEmbed `title` is returned as `suggestedTitle` and is **not**
   written over a title the creator supplied.

Playback needs no fourth step: the client renders the server-built
`https://www.youtube-nocookie.com/embed/<id>` in a sandboxed iframe. **Our servers are never in
the playback path**, which is also why `GET /videos/:id/playback-token` has nothing to sign
(§6) — gated tiers are rejected at the boundary instead (§0).

```text
1. POST /videos { youtubeUrl, title, … }
   → requireAuth resolves creatorId from the session cookie (NEVER the body).
   → CreateVideoSchema.safeParse → 422 on bad shape.
   → extractYoutubeVideoId(url)          → no id            → 422 INVALID_YOUTUBE_URL
   → reject investor_only / isNdaRequired → gated + youtube  → 422 GATING_UNSUPPORTED_FOR_SOURCE
   → GET youtube.com/oembed?url=…        → 401/403/404      → 422 YOUTUBE_VIDEO_UNAVAILABLE
                                          → timeout/5xx      → 502 YOUTUBE_VERIFY_FAILED
   → insert: videoSource "youtube", youtubeVideoId, uploadStatus "ready",
             thumbnailUrl = oEmbed thumbnail_url.
   → 201 { video, suggestedTitle }.   No upload URL — there is nothing to upload.

2. PATCH /videos/:id … metadata (a changed youtubeUrl re-runs steps 1-2);
   PUT /:id/chapters; PUT /:id/products; PUT /:id/playlists.

3. POST /videos/:id/publish
   → re-check: title + a visibility tier; re-reject gated tiers for youtube source.
   → normal video → publishStatus "published" (or "scheduled").
   → anime episode → reviewStatus "pending" (NOT published to /anime). → 200 PublicVideo.

4. Viewers: client renders https://www.youtube-nocookie.com/embed/<id> in a sandboxed iframe,
   rebuilt server-side from the stored id. The server never proxies playback.
```

**Ordering matters:** run the cheap local rejections (Zod, id extraction, gating) **before** the
oEmbed call. A malformed URL should never cost an outbound request, and a creator who picked
`investor_only` should be told so without waiting on YouTube.

If the creator abandons the flow after step 1 the row stays a `draft` — visible only to them in My
Videos, never to viewers. Unlike the hosted path there is no orphaned asset to sweep: the only
thing left behind is a database row.

---

## 10. Anime + admin-review boundary (RBAC)

Normal videos publish straight to the creator's channel. **Anime episodes are curated** and route
through staff review before appearing in `/anime` — the boundary specced in
[UPLOAD_VIDEO_STRUCTURE.md](UPLOAD_VIDEO_STRUCTURE.md) §3 and [ADMIN_STRUCTURE.md](ADMIN_STRUCTURE.md)
§4.1.

- **Two surfaces, never conflated.** The creator sees a read-only status badge inline in **My
  Videos** (`/studio/videos`) — Pending / Approved / Rejected + reason. Staff act at
  **`/admin/review`**. Same rows, different permissions. There is **no `/studio/queue`**.
- **On publish**, `videoType = anime_episode` → `reviewStatus: pending` (not live). A
  `moderator`/`admin` approves → **auto-publish** into `/anime` on/after the episode release date
  (admin decision #3), or rejects with a reason. Every decision writes a `content_review_action`.
- **Re-editing an approved/rejected anime episode resets it to `pending`** — edited content is
  re-reviewed (UPLOAD_VIDEO_STRUCTURE.md §3).
- **RBAC.** `user.role ∈ {user, moderator, admin}`. New middleware
  `src/middleware/require-role.ts`:

    ```ts
    export function requireRole(minimum: "moderator" | "admin") {
        return (req, res, next) => {
            if (!req.user) return respondUnauthenticated(res); // 401
            const rank = { user: 0, moderator: 1, admin: 2 };
            if (rank[req.user.role] < rank[minimum]) {
                return res
                    .status(403)
                    .json({ status: "error", statusCode: 403, message: "Forbidden." });
            }
            next();
        };
    }
    ```

    The role is loaded onto `req.user` from the session in `requireAuth` (extend the ambient
    `express.d.ts` type). **A client-claimed role is never trusted** (admin doc §2).

- **First admin — seed script** `scripts/seed-admin.ts`: if no `admin` exists, create/promote one
  from `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` (admin doc §7). Day-to-day promotion is a
  future `/admin/users` action; recovery is re-running the seed.
- The admin **open decision** ("keep anime **and** videos for approval") extends by defaulting
  `reviewStatus: pending` for other `videoType`s too — **no schema change**, just a flipped default.

---

## 11. Zero-trust checklist (per §0, applied to each route)

- `creatorId` / `ownerId` are **only** ever `req.user.id`. No owner field in any request schema.
- Ownership is re-checked in the **service** on every `:id` op; failure → `NOT_FOUND` → `404`.
- **The YouTube URL is parsed server-side against a hostname allowlist**, and the **id — never the
  client's string — is what gets stored.**
- **Every embed URL is rebuilt server-side** as `youtube-nocookie.com/embed/<id>`. No client
  string is ever interpolated into an `<iframe src>` or an `href`.
- **Existence/embeddability is server-verified via oEmbed** before the row is created;
  `uploadStatus`, `videoSource`, and `thumbnailUrl` are server-set, never client-claimed.
- **Gated tiers are refused, not faked.** `investor_only` / `isNdaRequired` on a YouTube row →
  `422 GATING_UNSUPPORTED_FOR_SOURCE`, checked on create, `PATCH`, **and** publish.
  `private`/`unlisted` are documented as Qatoto-surface visibility only — they do not protect the
  video, and no surface may imply that they do.
- Attached `productId`s are re-verified for ownership; buyer-facing price/inventory is always
  re-derived (STORE §0), never trusted from the attachment.
- Publish completeness and **anime approval** are decided server-side; the client's click is a
  request, not an authorization.
- Admin actions re-derive the role from the session (`requireRole`) and **audit-log** every decision.
- Every body/query is Zod `.safeParse()`d with `.strict()` → `422` before the service runs.

---

## 12. Frontend-behind-backend gaps (planned, not modeled here)

- **Pitch / funding domains.** The `video` row carries `attachedPitchId` and
  `hasFundingCallToAction` link fields, but the **pitch** (`/studio/pitches`) and **funding**
  (`/studio/funding`) products are separate subsystems with their own tables and docs. This doc owns
  the video-side attachment, not the pitch/funding domain.
- **Role applications.** `video_open_role` stores the roles; viewers *applying* to a role
  (applications, review, messaging) is a future feature.
- **NDA / investor identity.** `isNdaRequired` and `investor_only` are **rejected** for YouTube
  rows (§0). Verifying investor identity and recording NDA acceptance is a server-side flow to be
  specced when the investor product lands — and it is blocked on self-hosting
  ([Appendix A](#appendix-a--deferred-self-hosted-video-livepeer-direct-upload)), since a
  YouTube-hosted video cannot be gated at all.
- **Live streaming.** Out of scope — a separate doc. The `videoProvider` seam can grow a
  `createLiveStream()` method then.
- **Watch-side read API.** This doc is the **creator** contract. The public watch surface
  (`src/lib/videos.ts`, `QATOTO_VIDEO_API_URL`) is a separate read model.
- **Playlists picker / series editor polish, custom-vs-auto thumbnail UX** — frontend follow-ups;
  the contract is already here.

### Frontend follow-ups this change creates

The backend contract above is ahead of the frontend in four concrete places:

- **The watch player cannot render a YouTube video.**
  [video-player.tsx](src/components/home/watch/video-player.tsx) is a native `<video>` element
  with no iframe branch. It needs to switch on `videoSource` and render the embed for YouTube
  rows — the studio preview card already does exactly this and is the reference.
- **Admin review plays a hardcoded dummy file.**
  [episode-review-detail.tsx](src/components/admin/review/episode-review-detail.tsx) renders
  `/dummy/video/Sintel_1080_10s_1MB.mp4` for every episode and ignores `youtubeUrl` entirely, so a
  moderator approving an anime episode is **not watching the video they are approving**. This must
  be fixed before the review queue is trusted.
- **My Videos prints the raw URL** as a row's secondary line, because `fileName` holds the URL
  (§1 trap). Once `videoSource` is on `VideoListRow`, drop that line for YouTube rows.
- **The `SourceBadge` should read `videoSource`**, not `youtubeUrl !== ""`.

Also: **[UPLOAD_VIDEO_STRUCTURE.md](UPLOAD_VIDEO_STRUCTURE.md) predates the YouTube change** and
still describes a file-upload-first flow. Its §2–§4 are partly stale; treat this doc as
authoritative on the source question until it is refreshed.

---

## 13. Verification (when the backend phase begins)

1. `pnpm db:generate && pnpm db:migrate` — apply the new tables + enums + `user.role`.
2. Run `tsx scripts/seed-admin.ts`. **No provider credentials to configure** — that is the point.
3. Sign in (get a session cookie), then exercise the flow:

    ```bash
    # 1. create — parse + oEmbed verify happen inline; the video is ready immediately
    curl -X POST https://localhost:8000/videos -b cookies.txt -H 'content-type: application/json' \
      -d '{"title":"Seed round demo","youtubeUrl":"https://youtu.be/dQw4w9WgXcQ","videoType":"demo","visibility":"public"}'
    # → 201 { video: { id, videoSource:"youtube", youtubeVideoId:"dQw4w9WgXcQ",
    #                  uploadStatus:"ready", thumbnailUrl:"https://i.ytimg.com/…",
    #                  youtubeEmbedUrl:"https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" },
    #          suggestedTitle: "…" }

    # 2. read back — no waiting, no polling, no webhook
    curl https://localhost:8000/videos/<id> -b cookies.txt

    # 3. publish
    curl -X POST https://localhost:8000/videos/<id>/publish -b cookies.txt
    # → 200, publishStatus "published" (or reviewStatus "pending" for an anime_episode)

    # 4. My Videos list
    curl https://localhost:8000/videos/mine -b cookies.txt   # → row with videoSource + derived badge
    ```

4. **URL-shape coverage** — every form `extractYoutubeVideoId` accepts should create the same row:
   `youtu.be/<id>`, `youtube.com/watch?v=<id>`, `/embed/<id>`, `/shorts/<id>`, `/live/<id>`, and a
   bare 11-char id. Confirm the backend and frontend parsers agree; a URL the frontend green-ticks
   but the backend rejects is the bug this check exists to catch (§3).
5. **Cost check** — confirm no video bytes touched the server at all, and that create made exactly
   **one** outbound request (the oEmbed call). No provider API key was read.
6. **Field coverage** — every `StudioVideo` field in
   [studio-videos-context.tsx](src/state/studio-videos-context.tsx) maps to a column/child table
   (§4); every modal step (Details / Video elements / Checks / Visibility + anime branch) is covered.
7. **Negative checks:**
    - a non-YouTube URL (`https://vimeo.com/123`) → `422 INVALID_YOUTUBE_URL`
    - a lookalike host (`https://youtube.com.evil.tld/watch?v=x`) → `422 INVALID_YOUTUBE_URL`
    - a deleted/private video id → `422 YOUTUBE_VIDEO_UNAVAILABLE`
    - `"visibility":"investor_only"` or `"isNdaRequired":true` → `422 GATING_UNSUPPORTED_FOR_SOURCE`,
      on create **and** on a later `PATCH` **and** on publish
    - a body containing `youtubeVideoId`, `uploadStatus`, or `thumbnailUrl` → `422` from `.strict()`
    - publish a titleless draft → `422 INCOMPLETE_FOR_PUBLISH`
    - another creator's `GET /videos/:id` → `404` (never `403`)
    - `GET /videos/:id/playback-token` on any YouTube row → `409 NO_TOKEN_REQUIRED`
    - a non-moderator hitting `/admin/review` → `403`
    - oEmbed unreachable (block it in `/etc/hosts` or set a 1 ms timeout) → `502
      YOUTUBE_VERIFY_FAILED`, and **no row is written**

---

## Appendix A — Deferred: self-hosted video (Livepeer direct upload)

> ## ⛔ DO NOT BUILD THIS NOW
>
> Everything in this appendix is **deferred**. Self-hosting video was parked on **cost and
> complexity** grounds; the YouTube-link path in §0–§13 is what ships. Nothing here is mounted,
> configured, or installed today.
>
> It is preserved **unabridged** so that switching later is a **re-read, not a redesign** — the
> schema columns it needs are already in the table (nullable), the `videoSource` enum already has
> its variant, and the frontend already has a dormant dropzone. Delete none of it.
>
> **The trigger to revisit:** a product requirement this design provably cannot meet — almost
> certainly **confidential/investor-gated video** (§5.1), since a YouTube-hosted video cannot be
> gated at all. Secondary triggers: needing our own watch-time analytics, or wanting YouTube's
> branding and related-video chrome out of the player.

### A.1 Why it was cheap (the original cost argument)

The design goal was to keep running cost at or near zero at low volume, scaling linearly after.

1. **Bytes never transit Express.** `POST /videos` calls the provider's *request-upload* and
   returns a **short-lived, resumable upload URL** (Livepeer TUS endpoint). The browser uploads
   the file **directly to the provider** — the backend only ever moves small JSON. So there is
   **no server egress billed, no proxy bandwidth (which would be 2× — in then out), no multi-GB
   buffers in memory, and no long-held request timing out.** Contrast the naive design (client →
   our server → provider), which pays bandwidth twice and risks OOM on large files.

2. **Transcoding is offloaded, not self-hosted.** Livepeer's decentralized network does the
   transcode to adaptive HLS renditions. We run **no `ffmpeg`, no GPU/CPU transcode box**. That
   avoids the single biggest video cost (self-hosted transcode CPU, or Mux/AWS MediaConvert
   per-minute fees). Livepeer's free tier covers early volume; usage-based after.

3. **Playback = provider HLS + CDN.** The `playbackId` yields an `.m3u8` served from the
   provider's CDN with adaptive bitrate — **for free from our infra's perspective**. We serve no
   video bytes.

4. **Thumbnails are cheap.** Default to the provider's **auto-generated** frame ($0, arrives via
   the webhook). A **custom** thumbnail reuses the existing **Cloudinary + sharp** image pipeline
   — tiny images on a free tier.

5. **Gated playback only when needed.** Public/unlisted videos need no token — the HLS URL is
   plain. Only `private`/`investor_only`/NDA videos mint a **short-lived JWT** (A.4), so the auth
   cost is bounded to the gated minority. **This is the capability the YouTube path cannot
   replicate.**

6. **Webhooks, not polling.** The `uploading → processing → ready` transition is driven by the
   provider **calling us** (`asset.ready`), not by us polling the provider on a timer. **No idle
   compute, no wasted API calls.**

7. **Postgres stores only ids + metadata.** The DB holds `videoAssetId` / `playbackId` /
   metadata — kilobytes per video, not gigabytes. Negligible storage cost; no blob columns.

**Net:** at low volume this is effectively free (free tiers + our own server only shuffling JSON).
The dominant variable cost is provider transcode/delivery minutes, which are usage-based and among
the cheapest available. **Cheap, but not free — which is why it lost to the YouTube link for v1.**

> **Pricing caveat:** exact Livepeer free-tier limits and per-minute rates change and may be stale
> versus this doc — **verify current Livepeer Studio pricing** before committing volume.

### A.2 Provider portability (Livepeer → Cloudflare Stream / ImageKit / Hetzner)

Livepeer is **one implementation behind a seam**, so switching later is cheap and touches ~one file.

- **The frontend never names the provider.** It calls our `/videos` endpoints and uploads to the
  **opaque URL** we return. Swapping the backend provider leaves the frontend untouched (only the
  client upload lib changes if the *protocol* changes — TUS vs presigned PUT).

- **One seam — `src/lib/videoProvider.ts`** — an interface every provider implements:

    ```ts
    export interface VideoProvider {
        // Create a remote asset + return where the client uploads the bytes directly.
        requestUpload(input: { name: string }): Promise<
            Result<
                {
                    assetId: string;
                    playbackId: string;
                    upload: { url: string; protocol: "tus" | "put" };
                },
                ProviderError
            >
        >;
        deleteAsset(assetId: string): Promise<Result<void, ProviderError>>;
        // Mint a short-lived playback JWT for gated tiers.
        signPlayback(
            playbackId: string,
            ttlSeconds: number,
        ): Promise<Result<string, ProviderError>>;
        // Verify an inbound webhook and normalize it to a provider-neutral event.
        verifyWebhook(
            rawBody: Buffer,
            headers: Record<string, string>,
        ): Result<VideoWebhookEvent, ProviderError>;
    }
    ```

    `src/lib/livepeer.ts` is the first impl. `VIDEO_STORAGE_PROVIDER` selects it. Adding
    `cloudflareStream.ts` / `imagekit.ts` / `hetzner.ts` = implement those four functions — **no
    route, controller, or schema change.**

- **Provider-neutral columns** (`videoAssetId`, `playbackId`, `playbackUrl`, `uploadStatus`,
  `storageProvider`) mean old and new-provider assets **coexist**. Migration is **dual-run** (new
  uploads → new provider) with optional re-ingest of old assets. **No table drop, no rename.**
  The same property is what lets `youtube` and `hosted` rows coexist (§5.2).

- **Protocol-tagged upload response** (`{ upload: { url, protocol: "tus" | "put" } }`) means a
  provider that wants a presigned PUT instead of resumable TUS needs **no new endpoint** — the
  client branches on `protocol`.

- **Fit at a glance:** **Cloudflare Stream** — near drop-in (TUS upload, HLS, signed URLs,
  webhooks; very cheap). **ImageKit** — same endpoints, rewrite the seam. **Hetzner VPS** —
  cheapest $ but you own `ffmpeg` transcode + HLS serving + signed URLs + resumable upload; biggest
  seam rewrite, still no schema/frontend change.

### A.3 Files, env, and dependencies this path needs

```text
src/routes/webhooks.routes.ts        # POST /webhooks/livepeer (no auth, signature-verified)
src/controllers/webhooks.controller.ts  # verify signature, flip uploadStatus
src/lib/videoProvider.ts             # the provider seam (interface + selector)
src/lib/livepeer.ts                  # first impl: requestUpload/deleteAsset/signPlayback/verifyWebhook
```

```text
LIVEPEER_API_KEY=...
LIVEPEER_SIGNING_KEY_PUBLIC=...          # base64 PEM — gated playback
LIVEPEER_SIGNING_KEY_PRIVATE=...         # base64 PEM — gated playback
LIVEPEER_WEBHOOK_SECRET=...              # verify POST /webhooks/livepeer
VIDEO_STORAGE_PROVIDER=livepeer          # selects the videoProvider impl (A.2)
```

Backend dependencies: **none strictly required** — the Livepeer REST API is called with plain
`fetch` to stay dep-light (add the `livepeer` SDK only if preferred). The **frontend** adds
`tus-js-client` for the resumable direct upload. **No `@aws-sdk`, no `ffmpeg` on our servers.**

The webhook router must be mounted with the **raw** body for signature verification —
`express.raw({ type: "application/json" })` **before** the JSON parser, like the Better Auth
handler:

```ts
app.use("/webhooks", webhooksRouter); // raw body
```

### A.4 The four-layer pipeline

1. **Request upload (`POST /videos`).** The service calls
   `videoProvider.requestUpload({ name })`. Livepeer's impl `POST`s to
   `https://livepeer.studio/api/asset/request-upload` with the API key and returns
   `{ asset: { id, playbackId }, tusEndpoint, url }`. The service stores `videoAssetId`,
   `playbackId`, `uploadStatus: "uploading"` and returns
   `{ upload: { url: tusEndpoint, protocol: "tus" } }` to the client.

2. **Direct upload (client → provider).** The browser uses `tus-js-client` to upload the file
   **straight to `tusEndpoint`** — resumable, chunked, no server hop. The backend is not involved
   in the byte transfer (A.2). While it uploads, the UI polls `GET /videos/:id` (or listens) for
   `uploadStatus`.

3. **Webhook (provider → us).** When transcoding finishes, Livepeer calls
   `POST /webhooks/livepeer`. `videoProvider.verifyWebhook` checks the signature against
   `LIVEPEER_WEBHOOK_SECRET`; on `asset.ready` the service flips `uploadStatus: "ready"` and fills
   `durationSeconds` / `sizeBytes` / `playbackUrl` / auto-`thumbnailUrl`. This — not the client —
   is what lets a draft be published. `asset.failed` → `uploadStatus: failed`.
   Unknown/unverified → `400`, no state change. **This is the only authority for media
   readiness** — the client is never trusted for it (§0).

4. **Gated playback (`GET /videos/:id/playback-token`).** For `private`/`investor_only`/NDA videos,
   the service first authorizes the caller (owner, or an investor with an accepted NDA — enforced
   server-side, never client), then `videoProvider.signPlayback(playbackId, ttl)` mints a
   short-lived JWT signed with `LIVEPEER_SIGNING_KEY_PRIVATE`. The client appends it to the HLS URL.
   Public/unlisted videos skip this entirely (`409 NO_TOKEN_REQUIRED`).

```text
1. POST /videos {title, …}
   → requireAuth resolves creatorId from the session cookie (NEVER the body).
   → CreateVideoSchema.safeParse → 422 on bad shape.
   → videoProvider.requestUpload → store videoAssetId/playbackId, uploadStatus "uploading".
   → 201 { video, upload: { url, protocol: "tus" } }.

2. Client uploads the file DIRECTLY to url via tus-js-client. Backend sees no bytes.

3. Provider finishes → POST /webhooks/livepeer (signature-verified)
   → asset.ready: uploadStatus "ready" + duration/size/playbackUrl/thumbnail.

4. PATCH /videos/:id … fill metadata; PUT /:id/chapters; PUT /:id/products; PUT /:id/playlists.

5. POST /videos/:id/publish
   → re-check: title + uploadStatus "ready" + a visibility tier. missing → 422.
   → normal video → publishStatus "published" (or "scheduled").
   → anime episode → reviewStatus "pending" (NOT published to /anime). → 200 PublicVideo.
```

If the creator abandons the flow after step 1, the row stays a `draft` (and the un-finished asset
can be swept later) — visible only to them in My Videos, never to viewers.

Error union addition: `ProviderError` (from `videoProvider` — request-upload / delete / sign /
webhook) rejoins `VideoError` in §8, mapping to `503 PROVIDER_NOT_CONFIGURED` on create and `502`
on downstream failures.

### A.5 What flips when hosting lands

The whole point of the columns above. In rough order:

1. **Schema: nothing to migrate.** `videoAssetId`, `playbackId`, `playbackUrl`, `storageProvider`
   already exist and are nullable. `videoSource` already has `"hosted"`. New rows just populate
   them. **No table drop, no rename, no backfill** — `youtube` rows keep working untouched.
2. Add `lib/videoProvider.ts` + `lib/livepeer.ts`; set the `LIVEPEER_*` env vars that have been
   sitting unused in `.env.example` all along.
3. Mount `webhooks.routes.ts` with the raw-body parser **before** `express.json()`.
4. `POST /videos` grows a second shape: a body **without** `youtubeUrl` means "hosted" → call
   `requestUpload`, create at `uploadStatus: "uploading"`, and return the `upload` object.
   Keep the YouTube branch — both sources coexist permanently.
5. Re-enable `GET /videos/:id/playback-token` for `videoSource = "hosted"` rows; it keeps
   returning `409 NO_TOKEN_REQUIRED` for YouTube ones.
6. **Drop `GATING_UNSUPPORTED_FOR_SOURCE` for hosted rows only.** `investor_only` and NDA become
   real for hosted video; they stay rejected for YouTube, because that limitation never goes away.
7. Restore the `≤ durationSeconds` chapter bound for hosted rows (the webhook supplies a real
   duration; YouTube rows still have none).
8. **Frontend: remove `inert` + the dimming class from the dropzone** in
   [create-studio-page.tsx](src/components/studio/pages/create-studio-page.tsx). The drag/drop
   handlers, the file input, the queue list, and the `{ kind: "file" }` arm of `UploadSource` in
   [upload-modal.tsx](src/components/studio/upload/upload-modal.tsx) were never deleted — they
   wake up as-is. Add `tus-js-client`.
9. The `processing` badge branch in §8 becomes reachable again — it was deliberately left in.
