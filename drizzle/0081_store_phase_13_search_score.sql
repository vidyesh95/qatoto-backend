-- Store Phase 13 — the discovery score search can sort on, and the trigger that protects it.
--
-- WHY A COLUMN HERE AT ALL, when `commerce_product_ranking_state` already holds the score.
-- Because search cannot afford the join: `sort=discovery` with a LEFT JOIN to another table
-- cannot use an index for its ORDER BY, and this file's own non-relevance sorts already fall
-- back to unindexed scans — a known weakness, not a pattern to copy. A denormalized integer
-- with a partial index is the difference between a sort that scales and one that does not.
--
-- WHY NOT ON `commerce_product_stats`. That table was split off `product` specifically to
-- keep a buyer's tap off a seller's row. Putting an hourly whole-catalog UPDATE there would
-- set a batch job against the store's hottest interactive write.
--
-- ## The column is machine-owned and lives in a human-owned row
--
-- `refreshProductSearchDocument` upserts this table on every product edit with a `set` block
-- that enumerates columns by name. Today that block does not mention the score, so the score
-- survives — BY STYLE, NOT BY GUARANTEE. One contributor adding a field to that list, or
-- reusing `values()` more broadly, silently destroys every ranking the engine computed.
--
-- The trigger below makes that impossible. A writer must announce itself by setting
-- `qatoto.ranking_writer`, which only the ranking job does; anyone else's change to these two
-- columns is silently reverted to the stored value rather than applied. Silently ignored is
-- the right failure here: a hard error would break ordinary product edits for a mistake that
-- belongs to the ranking layer, and `discovery_score_computed_at` makes the staleness visible.
--
-- THE VERIFY SCRIPT DOES NOT TRUST THIS FILE. It attempts a write without the setting and
-- asserts the value did not move — because a trigger whose body is wrong still appears in
-- `pg_trigger`, so presence proves nothing.

-- NULL means "not scored", which is the correct state for most of the catalog most of the
-- time. No default, for the same reason `unique_viewer_count` has none: a 0 would be a claim.
ALTER TABLE "store_search_document" ADD COLUMN "discovery_score_points" integer;--> statement-breakpoint
ALTER TABLE "store_search_document" ADD COLUMN "discovery_score_computed_at" timestamp;--> statement-breakpoint

ALTER TABLE "store_search_document" ADD CONSTRAINT "store_search_document_discovery_score_ck" CHECK (
  (discovery_score_points IS NULL) = (discovery_score_computed_at IS NULL)
  AND (discovery_score_points IS NULL OR discovery_score_points BETWEEN 0 AND 100)
);--> statement-breakpoint

-- The `sort=discovery` index. Partial on eligibility because an ineligible document is never
-- returned by any search, and NULLS LAST so unscored products sort after scored ones instead
-- of ahead of them.
CREATE INDEX "store_search_document_discovery_idx" ON "store_search_document" USING btree ("is_eligible","discovery_score_points" DESC NULLS LAST,"id") WHERE is_eligible;--> statement-breakpoint

CREATE OR REPLACE FUNCTION store_preserve_discovery_score()
RETURNS trigger
LANGUAGE plpgsql
AS $store_preserve_discovery_score$
BEGIN
  -- `true` as the second argument makes `current_setting` return NULL instead of raising
  -- when the setting was never set, which is the normal case for every other writer.
  IF coalesce(current_setting('qatoto.ranking_writer', true), '') = 'on' THEN
    RETURN NEW;
  END IF;

  NEW.discovery_score_points := OLD.discovery_score_points;
  NEW.discovery_score_computed_at := OLD.discovery_score_computed_at;
  RETURN NEW;
END
$store_preserve_discovery_score$;--> statement-breakpoint

CREATE TRIGGER store_search_document_preserve_discovery_score
BEFORE UPDATE ON "store_search_document"
FOR EACH ROW EXECUTE FUNCTION store_preserve_discovery_score();
