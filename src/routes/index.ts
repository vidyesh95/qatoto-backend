import express from "express";
import type { Request, Response } from "express";

import { config } from "#src/config/index.js";
import { query } from "#src/db/index.js";
import { isCommercePiiEncryptionConfigured } from "#src/lib/commerce-pii-encryption.js";
import { errorFields, logger } from "#src/lib/logger.js";
import type { ApiResponse } from "#src/types/index.js";

const router = express.Router();

/**
 * GET /
 * Health check / welcome route.
 */
router.get("/", (req: Request, res: Response) => {
  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Welcome to QAToto API",
  };
  res.status(200).json(response);
});

/**
 * GET /health — LIVENESS. Unchanged, and deliberately so.
 *
 * "Is this process running and able to answer?" A liveness probe that touches a dependency
 * is a liveness probe that restarts a healthy process when the database blips, which turns
 * a brief outage into a rolling one. This is the endpoint an orchestrator kills on.
 */
router.get("/health", (req: Request, res: Response) => {
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "OK",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /ready — READINESS (R_AND_D_BACKEND_STRUCTURE.md §11l.2 item 5).
 *
 * WHY THIS EXISTS. `/health` answers uptime and a timestamp, and for a while that was the
 * only thing this app said about itself. With 27 queues, 9 crons and a separate worker
 * process, "the API answered" says nothing about whether any work is being done: a worker
 * that died leaves every verification queued, every notification undelivered and every
 * statement undrafted, and `/health` stays green throughout.
 *
 * TWO CHECKS, and each answers a different question:
 *   database — can this process reach Postgres at all? A `SELECT 1`, nothing more; a probe
 *              that queried a domain table would fail on an empty database.
 *   jobs     — has pg-boss been installed into its schema? That is the deploy step
 *              (`pnpm jobs:install`) most likely to be skipped, and skipping it means
 *              every `sendJob` fails at runtime rather than at boot.
 *
 * `503` when anything fails, with a per-check breakdown, because an operator needs to know
 * WHICH dependency is down and a bare 503 sends them to read logs to find out.
 *
 * IT DOES NOT CHECK THAT A WORKER IS ALIVE, and that is worth stating rather than implying:
 * the worker is a separate process with its own pool, and this endpoint runs in the API. A
 * queue-depth or last-heartbeat check is the honest way to answer that question, and it
 * belongs with the dead-letter tooling rather than here.
 */
async function reportReadiness(req: Request, res: Response): Promise<void> {
  const checks: Record<string, "ok" | "failed"> = {};

  try {
    await query("SELECT 1");
    checks["database"] = "ok";
  } catch (error: unknown) {
    checks["database"] = "failed";
    logger.error("readiness: database check failed", {
      requestId: req.requestId,
      ...errorFields(error),
    });
  }

  try {
    // pg-boss creates a `version` table in its own schema on install. Reading it proves the
    // queue tables exist without enqueuing anything or starting a second boss instance.
    await query(`SELECT 1 FROM ${config.JOBS_SCHEMA}.version LIMIT 1`);
    checks["jobs"] = "ok";
  } catch (error: unknown) {
    checks["jobs"] = "failed";
    logger.error("readiness: job schema check failed", {
      requestId: req.requestId,
      ...errorFields(error),
    });
  }

  if (config.NODE_ENV === "production") {
    checks["commercePiiEncryption"] = isCommercePiiEncryptionConfigured() ? "ok" : "failed";
  }

  const isReady = Object.values(checks).every((state) => state === "ok");

  res.status(isReady ? 200 : 503).json({
    status: isReady ? "success" : "error",
    statusCode: isReady ? 200 : 503,
    message: isReady ? "Ready." : "Not ready — a dependency is unavailable.",
    data: { checks, uptime: process.uptime(), timestamp: new Date().toISOString() },
  } satisfies ApiResponse);
}

/**
 * Mounted through a synchronous wrapper rather than as an `async` handler, which the repo's
 * lint rule holds the line on for the whole codebase.
 *
 * Both dependency checks are already `try`/`catch`ed, so the only way this rejects is a bug
 * in the responder itself — and a readiness probe that answers 503 with a breakdown is more
 * useful to an operator than one that dies into the generic error handler. So the failure
 * is logged and answered here rather than forwarded.
 */
router.get("/ready", (req: Request, res: Response) => {
  reportReadiness(req, res).catch((error: unknown) => {
    logger.error("readiness probe itself failed", {
      requestId: req.requestId,
      ...errorFields(error),
    });
    res.status(503).json({
      status: "error",
      statusCode: 503,
      message: "Not ready — the readiness probe failed.",
    } satisfies ApiResponse);
  });
});

export default router;
