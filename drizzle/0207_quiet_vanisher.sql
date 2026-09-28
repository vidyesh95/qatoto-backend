ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'search_term_suppressed' BEFORE 'discovery_skill_created';--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'search_term_unsuppressed' BEFORE 'discovery_skill_created';--> statement-breakpoint
CREATE TABLE "search_query_log" (
	"search_day" date NOT NULL,
	"normalized_term" text NOT NULL,
	"searcher_fingerprint" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "search_query_log_search_day_normalized_term_searcher_fingerprint_pk" PRIMARY KEY("search_day","normalized_term","searcher_fingerprint"),
	CONSTRAINT "search_query_log_term_ck" CHECK (char_length(normalized_term) BETWEEN 2 AND 80 AND normalized_term = lower(normalized_term))
);
--> statement-breakpoint
CREATE TABLE "search_term_suppression" (
	"term" text PRIMARY KEY NOT NULL,
	"suppressed_by_user_id" text,
	"reason" text NOT NULL,
	"suppressed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "search_term_suppression_ck" CHECK (char_length(term) BETWEEN 2 AND 80 AND term = lower(term)
          AND char_length(reason) BETWEEN 1 AND 2000)
);
--> statement-breakpoint
CREATE TABLE "trending_search_term" (
	"rank" integer PRIMARY KEY NOT NULL,
	"term" text NOT NULL,
	"searcher_count" integer NOT NULL,
	"as_of" timestamp NOT NULL,
	CONSTRAINT "trending_search_term_ck" CHECK (rank BETWEEN 1 AND 5 AND searcher_count >= 5 AND char_length(term) BETWEEN 2 AND 80)
);
--> statement-breakpoint
ALTER TABLE "search_term_suppression" ADD CONSTRAINT "search_term_suppression_suppressed_by_user_id_user_id_fk" FOREIGN KEY ("suppressed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trending_search_term_term_unq" ON "trending_search_term" USING btree ("term");