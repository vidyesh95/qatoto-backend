import express from "express";

import { longFormBody } from "#src/middleware/json-body.js";
import { assistantReplyDailyLimiter, assistantReplyLimiter } from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";
import * as assistantController from "#src/modules/assistant/assistant.controller.js";

/**
 * The AI assistant's cloud route (qatoto-frontend's AI Assist Mode).
 *
 * ## ONE ROUTE, AND IT IS THE FALLBACK
 *
 * The frontend answers on the person's own device when Chrome can run Gemini Nano, and only
 * calls here when it cannot. So this route serves the people whose browsers could not keep the
 * conversation local, and it keeps nothing either (`assistant.service.ts`).
 *
 * ## TWO LIMITERS AND `requireIdentifiedUser`, BECAUSE EVERY CALL SPENDS PROVIDER QUOTA
 *
 * `requireAuth` alone is nearly free to satisfy (the `anonymous()` plugin mints sessions), so the
 * identity guard prices an account and the limiters bound what one account can spend: a burst
 * limit for a runaway client and a daily cap for a patient one. The limiters run BEFORE the guard,
 * the same order `feedback.routes.ts` uses, so a flood of anonymous calls is counted too.
 *
 * ## `longFormBody`, NOT `compactBody`
 *
 * Ten 800-character turns and twenty 200-character notes can exceed 16 KB once encoded, and
 * `json-body-budget.test.ts` refuses a cap below what the schema can produce.
 *
 * ## NO `idempotency()`
 *
 * A reply writes nothing. Sending the same question twice costs a second model call and returns a
 * second answer, which is what a person pressing Send twice asked for.
 */
const router = express.Router();

router.post(
  "/replies",
  requireAuth,
  assistantReplyLimiter,
  assistantReplyDailyLimiter,
  requireIdentifiedUser,
  longFormBody,
  assistantController.createAssistantReply,
);

export default router;
