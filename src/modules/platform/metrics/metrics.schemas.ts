import { z } from "zod";

import { WATCH_ROLLUP_RETENTION_DAYS } from "#src/lib/engagement-retention.js";
import { USER_SEGMENTS } from "#src/modules/platform/metrics/platform-metrics.service.js";

/**
 * Query validation for §3.3a. `.strict()` throughout, matching every other query schema here: an
 * unknown key is a 422 rather than an ignored filter, so a caller that misspells `from` learns it
 * instead of quietly receiving the default window.
 */

/** A bare UTC calendar date. Not an instant — every column these windows filter is a `date`. */
const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "Not a real calendar date.");

/**
 * The widest window any metrics read will answer.
 *
 * A CAP RATHER THAN A PAGE, because these endpoints aggregate: there is nothing to paginate, only
 * a scan to bound. Asking for more than the data can cover would return a graph that is honestly
 * empty on its left half and would look like a collapse in usage.
 *
 * IMPORTED RATHER THAN RESTATED. This is the retention horizon, not a number that resembles it —
 * writing `762` here would let the cap and the prune drift apart on the day either moves, which is
 * the same argument `platform-metrics.service.ts` makes for deriving its rollup boundary from
 * `ACTIVITY_HOUR_RETENTION_DAYS`.
 */
const MAXIMUM_WINDOW_DAYS = WATCH_ROLLUP_RETENTION_DAYS;

export const MetricsWindowQuerySchema = z
  .object({
    fromDate: IsoDateSchema,
    toDate: IsoDateSchema,
  })
  .strict()
  .refine((query) => query.fromDate <= query.toDate, {
    message: "fromDate must not be after toDate.",
    path: ["fromDate"],
  })
  .refine(
    (query) =>
      (Date.parse(`${query.toDate}T00:00:00Z`) - Date.parse(`${query.fromDate}T00:00:00Z`)) /
        86_400_000 <=
      MAXIMUM_WINDOW_DAYS,
    { message: `The window may not exceed ${String(MAXIMUM_WINDOW_DAYS)} days.`, path: ["toDate"] },
  );

/**
 * `window` is the ROLLING WIDTH in days, not a bucket size — 1 for DAU, 7 for WAU, 30 for MAU.
 * Named as an enum rather than a free integer so the three published metrics stay the three
 * published metrics; an arbitrary width would be a different question with no agreed name.
 */
export const ActiveUsersQuerySchema = MetricsWindowQuerySchema.safeExtend({
  window: z.enum(["day", "week", "month"]).default("day"),
});

export const ROLLING_DAYS_BY_WINDOW: Readonly<Record<"day" | "week" | "month", number>> = {
  day: 1,
  week: 7,
  month: 30,
};

export const RetentionCohortsQuerySchema = z
  .object({
    // Two years of cohorts at most, for the same reason the window is capped: the rollup does not
    // reach further back, and a grid whose oldest rows are structurally empty reads as churn.
    months: z.coerce.number().int().min(1).max(25).default(12),
  })
  .strict();

export const UserSegmentQuerySchema = z
  .object({
    segment: z.enum(USER_SEGMENTS),
    // Deliberately small. This is a list of named people; a caller who wants a thousand of them
    // wants an export, and an export is a different decision with a different conversation.
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
