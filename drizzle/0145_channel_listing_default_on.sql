-- ---------------------------------------------------------------------------
-- Channel listing flips to opt-OUT. `0144` shipped it opt-in; this reverses that.
--
-- WHY THE REVERSAL. `0144` defaulted this FALSE on the argument that a directory of PEOPLE is not a
-- directory of products. That argument was answered rather than overruled, and the answer is the
-- one fact it did not weigh: **the channel page is already public, and already linked from every
-- feed card** — `VideoCard` renders a creator's avatar and name as two links to it, on the home
-- page and in the watch page's recommended rail. Indexing it reveals nothing a visitor cannot
-- already reach by clicking. The cofounder directory's consent question is about publishing facts
-- about somebody who never chose to be listed; this publishes a page they chose to create.
--
-- The observed consequence settled it. Opt-in shipped and stayed at **zero listed channels**,
-- because nobody ticks a box they are never shown — so the sitemap announced nothing while the
-- pages it would have announced were public the whole time.
--
-- YouTube indexes channel pages by default and offers no per-channel search-engine toggle at all.
-- Keeping the control as an opt-OUT leaves this stricter than YouTube, not looser.
--
-- ## THE BACKFILL IS THE POINT, NOT THE DEFAULT
--
-- `SET DEFAULT` reaches only rows written after it. Without the UPDATE below every existing
-- creator stays false and the sitemap stays empty — the change would look applied and do nothing.
--
-- ⚠️ IT IS SCOPED TO LIVE ACCOUNTS. `anonymized_at IS NULL` keeps an erased account out: the scrub
-- forces this column false precisely so a deleted person stops being advertised to search engines,
-- and a blanket UPDATE would undo that for every account already scrubbed.
--
-- ## WHAT STILL FILTERS, AND IT IS NOW THE ONLY THING THAT DOES
--
-- `GET /channels` requires at least one publicly-servable video, joined under
-- `publicVideoPredicate()`. That gate used to be the second of two; it is now the only one, and it
-- is what stops the sitemap filling with soft 404s for channels that have published nothing.
-- ---------------------------------------------------------------------------

ALTER TABLE "user" ALTER COLUMN "is_channel_listed" SET DEFAULT true;
--> statement-breakpoint

UPDATE "user" SET "is_channel_listed" = true WHERE "anonymized_at" IS NULL;
