-- HAND-EDITED. drizzle-kit generated the ALTER and the CREATE INDEX below; the function
-- above them is written by hand, exactly as 0008 hand-wrote `CREATE EXTENSION citext`.
--
-- WHY IT EXISTS. `video.search_document` is GENERATED ALWAYS, and Postgres requires a
-- generation expression to be IMMUTABLE. `array_to_string(anyarray, text)` is only STABLE —
-- its result depends on the element type's output function, which in general may not be
-- immutable — so using it directly fails with "generation expression is not immutable" and
-- the column is never created.
--
-- THE MARKER IS NOT A LIE. This wrapper is narrowed to `text[]`, whose output function is
-- `textout`, which is immutable. The generic signature is what forced Postgres to be
-- conservative; at this concrete type the guarantee actually holds.
--
-- STRICT is deliberate: `video.tags` is NOT NULL DEFAULT '{}', so NULL never reaches this in
-- practice, and if it somehow did, a NULL result is coalesced to '' by the caller rather than
-- silently emptying the whole document through a NULL concatenation.
CREATE OR REPLACE FUNCTION text_array_to_search_text(text[])
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
AS $$ SELECT coalesce(array_to_string($1, ' '), '') $$;--> statement-breakpoint
ALTER TABLE "video" ADD COLUMN "search_document" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
          setweight(to_tsvector('english', text_array_to_search_text(tags)), 'B') ||
          setweight(to_tsvector('english', coalesce(description, '')), 'C')) STORED;--> statement-breakpoint
CREATE INDEX "video_search_document_idx" ON "video" USING gin ("search_document");
