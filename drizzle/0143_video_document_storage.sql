-- ---------------------------------------------------------------------------
-- Video documents — the deck/whitepaper under a video, reshaped for object storage.
--
-- WHY THIS EXISTS. `video_document` has existed since the studio schema did, is read by
-- `videos.service.ts` and by nothing else, and **nothing has ever written it** — 0 rows. The
-- studio's "Attach documents" control collects a `File`, keeps `file.name`, throws the bytes away
-- and drops even the name at save, because `POST /videos` is `.strict()` and has no document field.
-- The copy under that control promises "Deck or whitepaper shown as a download under the video".
-- A creator who used it lost their file with no error. This is the write half.
--
-- ZERO ROWS, SO THIS IS FREE. Every change below would need a backfill against a populated table;
-- against an empty one it is a reshape. Confirmed by count before writing this, not assumed from
-- the absence of a writer — a table with no writer in THIS repo could still have rows from another.
--
-- ## `url` IS DROPPED, AND THAT IS THE LOAD-BEARING CHANGE
--
-- The obvious shape is "upload somewhere, store the URL". It is wrong here, and not merely
-- redundant: **A URL OUTLIVES THE GATE.** A video can be unpublished, made private, or deleted;
-- a URL handed out while it was public keeps working forever, because the bytes do not know the
-- row's visibility changed. Storing an object KEY instead forces every download through a route
-- that re-checks the video's public gate on that request, which is the only way the document's
-- reachability can track the video's.
--
-- It also keeps the bucket private, which `object-storage.ts` states as a module-wide invariant.
--
-- ## CONTENT-ADDRESSED, WHICH IS WHY THERE IS NO IDEMPOTENCY KEY
--
-- `object_storage_key` is derived from `content_sha256`, so the same bytes always land at the same
-- key, and `video_document_content_uidx` makes the same bytes at most one row per video. A retried
-- upload therefore CONVERGES — same object, same row — rather than duplicating. That is stronger
-- than a replayed response, and it is the same argument `research-programs.routes.ts` already makes
-- for `POST …/papers/:paperId/file`, which likewise takes no `idempotency()` middleware.
--
-- The uniqueness is scoped to `(video_id, content_sha256)`, NOT global on the hash: two creators
-- may legitimately attach the same public whitepaper, and a global unique would make the second
-- one a 409 about a row they cannot see.
--
-- ## NO ANONYMIZATION-MANIFEST ENTRY, DELIBERATELY
--
-- The manifest is keyed on FOREIGN KEY COLUMNS INTO `user`. This table has none — it reaches a
-- person only through `video.creator_id`, and `video` already cascades from `user` ("a video bears
-- no ledger, equity or audit weight, so it is a possession that dies with the account"). Adding an
-- entry here would fail the verifier's check 2 as stale, exactly as one for `user.bio` would have.
--
-- ⚠️ THE CASCADE CLEANS THE ROWS AND NOT THE BYTES. `video_document` cascades from `video`, which
-- cascades from `user`, so deleting a video or anonymizing an account drops these rows and leaves
-- the objects in the bucket. That is handled in code, at the two sites that already delete their
-- own assets — `deleteVideo` (beside `deleteThumbnailAsset`) and `anonymizeAccount` (beside
-- `deleteUserAvatar`). It cannot be handled here: SQL does not reach object storage.
-- ---------------------------------------------------------------------------

ALTER TABLE "video_document" DROP COLUMN "url";
--> statement-breakpoint

-- NOT NULL with no DEFAULT is safe only because the table is empty. Against rows this would need a
-- backfill; the count was checked first.
ALTER TABLE "video_document" ADD COLUMN "object_storage_key" text NOT NULL;
--> statement-breakpoint
ALTER TABLE "video_document" ADD COLUMN "content_sha256" text NOT NULL;
--> statement-breakpoint
ALTER TABLE "video_document" ADD COLUMN "byte_size" integer NOT NULL;
--> statement-breakpoint

-- A zero-byte document is not a document. `validatePdfBytes` rejects it long before this, so the
-- CHECK is the floor under a bug rather than the validation — the same relationship
-- `daily_log_youtube_id_format_ck` has to the parser above it.
ALTER TABLE "video_document"
  ADD CONSTRAINT "video_document_byte_size_ck" CHECK ("byte_size" > 0);
--> statement-breakpoint

-- 64 lowercase hex characters. Pinned in the schema because the key is DERIVED from this column:
-- a value with a slash or a `..` in it would compose an object key pointing somewhere else.
-- Validation happens in code too; this is what makes it true of every row regardless of writer.
ALTER TABLE "video_document"
  ADD CONSTRAINT "video_document_content_sha256_ck"
  CHECK ("content_sha256" ~ '^[0-9a-f]{64}$');
--> statement-breakpoint

CREATE UNIQUE INDEX "video_document_content_uidx"
  ON "video_document" ("video_id", "content_sha256");
