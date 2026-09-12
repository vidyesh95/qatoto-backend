DROP INDEX "case_study_source_url_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "case_study_source_url_uidx" ON "case_study_source" USING btree ("case_study_id","url");