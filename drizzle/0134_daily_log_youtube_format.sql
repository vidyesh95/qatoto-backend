-- ---------------------------------------------------------------------------
-- THE SSRF GUARD DAILY LOGS NEVER GOT.
--
-- `video.youtube_video_id` has carried a charset CHECK since 0012, and that constraint's own
-- comment states plainly what it is for: the id is interpolated into an outbound oEmbed URL
-- and into every embed URL the system emits, and the 11-character charset contains no ".",
-- "/", ":", "@" or "%", "which is what closes SSRF and injection at the storage layer even if
-- a future write path forgets to parse".
--
-- `daily_log.youtube_video_id` holds exactly the same kind of value, is interpolated into
-- exactly the same URLs by `buildYoutubeEmbedUrl`, and has had only the source/id PAIRING
-- check (`daily_log_video_ck`) since 0013. The pairing check says an id EXISTS when the source
-- is youtube. It says nothing at all about what the id may contain.
--
-- The parse in the service is not a substitute. That is the argument the studio constraint
-- already makes: a defence that lives only in one code path is a defence that ends the first
-- time somebody adds a second write path — and this change adds one, a deferred job.
--
-- SAFE ON LANDING, verified before writing this file: every existing `daily_log` row with a
-- non-null id already matches, so the constraint validates with no backfill and no exclusion.
--
-- RUN ORDER: one constraint. Nothing is dropped and nothing is rewritten.
-- ---------------------------------------------------------------------------

ALTER TABLE "daily_log" ADD CONSTRAINT "daily_log_youtube_id_format_ck"
  CHECK (youtube_video_id IS NULL OR youtube_video_id ~ '^[A-Za-z0-9_-]{11}$');
