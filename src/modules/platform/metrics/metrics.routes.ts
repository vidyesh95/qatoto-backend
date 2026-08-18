import express from "express";

import { requireAuth } from "#src/middleware/require-auth.js";
import * as metricsController from "#src/modules/platform/metrics/metrics.controller.js";

const router = express.Router();

/**
 * Platform activity and watch-time metrics — HOME_BACKEND_STRUCTURE.md §3.3a.
 *
 * ALL READS, ALL `view_platform_metrics`, HELD BY `admin` ALONE. The capability is checked inside
 * each service call rather than by middleware, for the reason every other staff router states:
 * middleware cannot return a `Result` and so cannot take part in the controller's exhaustive
 * error switch.
 *
 * ROUTE ORDER: every path here is a distinct literal under `/admin/metrics`, so nothing shadows
 * anything. If a `/admin/metrics/:something` is ever added it goes BELOW all five, or `/users`
 * resolves as "the metric named users" and answers a plausible 404.
 *
 * ONE OF THESE FIVE IS AUDITED. `/users` returns named accounts and writes to the platform chain;
 * the four aggregates name nobody and deliberately do not. See `platform-metrics.service.ts`.
 */

router.get("/admin/metrics/active-users", requireAuth, metricsController.getActiveUsers);

router.get("/admin/metrics/watch-time", requireAuth, metricsController.getWatchTimeDistribution);

router.get("/admin/metrics/activity-hours", requireAuth, metricsController.getActivityByHour);

router.get("/admin/metrics/retention-cohorts", requireAuth, metricsController.getRetentionCohorts);

router.get("/admin/metrics/users", requireAuth, metricsController.listUserSegment);

export default router;
