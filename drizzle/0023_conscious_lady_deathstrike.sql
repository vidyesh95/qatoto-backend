-- §11k.2 — the project ↔ market insight citation.
--
-- The Overview tab's demand-evidence chips had nothing to read: `market_insight` joined to a
-- region, a category and an author, and no table anywhere joined one to a project. §11j.1
-- recorded the chips as dark because the LINK could not be created; the real cause was that
-- the relation did not exist. Unlike §11k.1, which was a projection gap over data already in
-- the schema, this is the data.
--
-- NO `source` ENUM, so ONE migration rather than two. `problem_cluster_project_link` (0011)
-- carries `problem_cluster_link_source` because `origin` is semantically distinct and its 1:1
-- can only be enforced by a partial unique index. A citation has neither property: every row
-- means the same thing and there is no cardinality to bound. That also sidesteps 0019's and
-- 0022's trap — Postgres refuses to USE an enum value in the transaction that created it, so
-- a new enum referenced by a CHECK would have forced a second migration.
--
-- BOTH FKs ARE `restrict`, matching 0011. A cited insight is evidence; deleting it out from
-- under a project that cites it would silently rewrite that project's stated basis. The
-- moderator DELETE on `/discovery/admin/market-insights/:insightId` therefore starts failing
-- with 23503 once an insight is cited, which is the intended answer: unpublish it instead.

CREATE TABLE "market_insight_project_link" (
	"project_id" text NOT NULL,
	"insight_id" text NOT NULL,
	"linked_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "market_insight_project_link_project_id_insight_id_pk" PRIMARY KEY("project_id","insight_id")
);
--> statement-breakpoint
ALTER TABLE "market_insight_project_link" ADD CONSTRAINT "market_insight_project_link_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_insight_project_link" ADD CONSTRAINT "market_insight_project_link_insight_id_market_insight_id_fk" FOREIGN KEY ("insight_id") REFERENCES "public"."market_insight"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_insight_project_link" ADD CONSTRAINT "market_insight_project_link_linked_by_user_id_user_id_fk" FOREIGN KEY ("linked_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_insight_project_link_insightId_idx" ON "market_insight_project_link" USING btree ("insight_id");