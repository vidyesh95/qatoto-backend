-- ---------------------------------------------------------------------------
-- THE VIDEO SIDE OF THE R&D HANDOFF — the mirror of `product.research_project_id`.
--
-- 0020 gave `product` a nullable FK to `research_project` and the comment on it says that
-- column is "the only place 'this project shipped this listing' is expressible". Studio has
-- had no equivalent, so a venture's own videos and the venture were two unrelated facts: the
-- watch page could not name the project, and the project page could not assemble its own reel
-- without a creator hand-linking every video somewhere else.
--
-- NULL IS UNAFFILIATED CONTENT, NOT MISSING DATA. Anime episodes and general creator uploads
-- carry NULL forever and are untouched by every read this column enables. That is why the
-- index below is partial: the rows that matter are the small minority.
--
-- `restrict`, MATCHING THE STORE COLUMN, and for the same reason. A venture with videos
-- pointing at it is not silently deletable. Note this does NOT create the delete-semantics
-- hazard that killed the `daily_log.video_id` proposal: the edge points video -> project, so
-- a user account cascading into its videos still cascades cleanly, and no equity evidence
-- ends up behind a possession.
--
-- WHO MAY SET IT IS ENFORCED IN THE SERVICE, NOT HERE. `video.creator_id` is a plain user and
-- venture identity is a `project_member` row, so the write path re-verifies active membership
-- AND `research_project.status = 'active'` before accepting a value — the same shape as the
-- `video_attached_product` ownership re-check. A CHECK constraint cannot express that.
--
-- RUN ORDER: column -> constraint -> index. Additive; the column is nullable, so every
-- existing row and every existing reader is unaffected.
-- ---------------------------------------------------------------------------

ALTER TABLE "video" ADD COLUMN "research_project_id" text;--> statement-breakpoint

ALTER TABLE "video"
  ADD CONSTRAINT "video_research_project_id_research_project_id_fk"
  FOREIGN KEY ("research_project_id") REFERENCES "public"."research_project"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "video_research_project_idx"
  ON "video" USING btree ("research_project_id")
  WHERE "research_project_id" IS NOT NULL;
