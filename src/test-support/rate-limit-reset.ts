/**
 * Empty every rate-limit bucket the current test file has filled.
 *
 * WHY THIS IS NEEDED, and it is not obvious from any test file. Under `NODE_ENV=test`
 * `isRateLimitStoreShared` is false (`src/config/index.ts`), so all ~111 limiters run on
 * per-process memory stores created once, when `rate-limit.ts` is imported. Nothing resets them
 * between tests, and express-rate-limit's window is wall-clock — fifteen minutes for the signup
 * limiters, a minute for the commerce ones — so within a file the counts only ever go up. A
 * suite that makes fifteen writes against a limit of twenty is five requests from a 429 that
 * would be reported against whichever test happened to run last.
 *
 * That failure mode is wall-clock dependent, not worker dependent: it reproduces at
 * `--maxWorkers=1`, and `--sequence.shuffle` only changes which test wears it.
 *
 * ## ⚠️ THIS USED TO RESET ONE KEY PER LIMITER, AND THAT WAS THE BUG
 *
 * It called `resetKey(TEST_SESSION_USER.id)`, because `userKey` in `rate-limit.ts` returns
 * `req.user?.id` and all but three limiters sit behind `requireAuth`. It had to guess a key:
 * express-rate-limit built each store itself, so the only handle a test had was the
 * middleware's `resetKey`, which needs to be TOLD the key.
 *
 * The three limiters that are not keyed on a user id are the signup ones, and
 * `signupCompleteIpLimiter` is keyed on the IP — so its bucket was never emptied.
 * `auth.routes.test.ts` has nine tests that each POST once to `/signup/complete` against a limit
 * of 12, plus one that loops until it sees a 429. In declaration order the loop ran last and
 * everything passed; under `--sequence.shuffle --sequence.seed=1789211105033` it ran first and
 * took all nine down with a 429 that read as "expected 429 to be 401".
 *
 * `resetAllRateLimitBuckets` is key-INDEPENDENT, so this can no longer be right for some
 * limiters and wrong for others, and adding an IP- or email-keyed route cannot silently
 * reintroduce the flake. It throws rather than no-opping if there is nothing to reset.
 *
 * The import is LAZY, inside the function, on purpose — twice over. `rate-limit.ts` pulls in
 * `config`, which throws unless the environment is stubbed, and `stubServerEnvironment()` runs
 * in the suite: after this module is imported, before this function is called. And IMPORTING
 * `rate-limit.ts` IS WHAT CONSTRUCTS THE LIMITERS, and therefore the stores this then resets —
 * so it stays even though nothing is read from it.
 */
export async function resetRateLimiters(): Promise<void> {
  await import("#src/middleware/rate-limit.js");
  const { resetAllRateLimitBuckets } = await import("#src/middleware/rate-limit-store.js");

  resetAllRateLimitBuckets();
}
