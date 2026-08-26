-- ---------------------------------------------------------------------------
-- THE RECRUITING LABEL BECOMES A REAL ROLE — `video_open_role.open_role_id`.
--
-- `video_open_role.role_title` is free text and always has been: a creator types "designer
-- needed" under their video and it points at nothing. A viewer who wants the job has no
-- button, because there is nothing to apply TO. The R&D side has had the whole apply flow for
-- some time — `project_open_role`, `project_application`, the slots counter, the skills
-- subset check — and the two have never been connected.
--
-- NULLABLE, AND `role_title` STAYS. Anime and unaffiliated videos keep typing whatever they
-- like and are completely untouched; the FK is an upgrade for videos that named a venture,
-- not a new requirement. A row with a null `open_role_id` renders exactly as it does today.
--
-- `restrict`, not cascade: a role a video is advertising is not silently deletable. Closing a
-- role is `project_open_role.status`, which the watch page reads — the row stays, the button
-- stops.
--
-- WHAT THIS DOES NOT DO, and the distinction is the point of §12's original refusal:
-- `video_open_role` is still NOT `project_open_role`. It carries no equity, no slots, no
-- status of its own. It POINTS at the row that carries those, and the watch page renders a
-- projection of that row. The service refuses an `open_role_id` that does not belong to the
-- video's own `research_project_id`, so a video cannot advertise another venture's vacancy.
--
-- RUN ORDER: column -> constraint -> index. Additive; nullable, so every existing row and
-- every existing reader is unaffected.
-- ---------------------------------------------------------------------------

ALTER TABLE "video_open_role" ADD COLUMN "open_role_id" text;--> statement-breakpoint

ALTER TABLE "video_open_role"
  ADD CONSTRAINT "video_open_role_open_role_id_project_open_role_id_fk"
  FOREIGN KEY ("open_role_id") REFERENCES "public"."project_open_role"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "video_open_role_open_role_idx"
  ON "video_open_role" USING btree ("open_role_id")
  WHERE "open_role_id" IS NOT NULL;
