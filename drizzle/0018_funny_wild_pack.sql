-- One open period per project PER MONTH, replacing 0017's one-per-project index.
--
-- 0017 got this wrong. §7A.5's close job stops a period accruing WITHOUT freezing it, so
-- a founder who has not finalized March yet must still accrue April — two `open` periods
-- at once, which the original index forbade outright. The corrected index is scoped to
-- the month, and still to `open` so a supersede can create a replacement over the same
-- window (the predecessor is `superseded` by then).
DROP INDEX "compensation_period_projectId_open_unq";--> statement-breakpoint
CREATE UNIQUE INDEX "compensation_period_projectId_start_open_unq" ON "compensation_period" USING btree ("project_id","period_start_date") WHERE status = 'open';