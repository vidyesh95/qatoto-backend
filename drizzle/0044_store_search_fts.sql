ALTER TABLE "store_search_document" ADD COLUMN "search_document" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(organization_display_name, '')), 'B') ||
          setweight(to_tsvector('english', coalesce(summary, '') || ' ' || coalesce(search_text, '')), 'C')) STORED;--> statement-breakpoint
CREATE INDEX "store_search_document_fts_idx" ON "store_search_document" USING gin ("search_document");
