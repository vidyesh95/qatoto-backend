import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    /**
     * FOUR TIMES THE 5000 ms DEFAULT, and the reason is contention rather than slow code.
     *
     * `test:shuffle` runs with `--maxWorkers=50%`, and this machine reports
     * `availableParallelism` 8 while having four performance cores — `764b997` recorded that
     * already. Under that oversubscription a supertest request that takes 5 ms alone can miss a
     * 5000 ms budget.
     *
     * WHAT MAKES A MISSED BUDGET WORSE THAN A SLOW TEST. Vitest does not kill the abandoned
     * request; it moves to the next test, whose `beforeEach` re-writes the shared session box in
     * `test-support/auth-mock.ts` and clears the shared spies. The orphaned request then lands
     * against the NEXT test's state, so the failure is reported against the wrong test and reads
     * as a 401 or a missing spy call rather than as a timeout. That is why the same flake was
     * recorded twice — once here, once in `commerce-rfqs.routes.test.ts` — without a cause.
     *
     * This does not make it impossible, and it is not meant to. It makes it rare enough to stop
     * misattributing, and the status assertions added alongside make it legible when it happens.
     *
     * ── CORRECTIONS, from measuring rather than reasoning ────────────────────────────────
     *
     * THE TRIGGER NAMED ABOVE IS WRONG. It blames oversubscription under `test:shuffle`. The
     * flake reproduces on plain `pnpm test` — bare `vitest run`, no `--sequence.shuffle`, no
     * `--maxWorkers` override — at roughly one run in twelve.
     *
     * A TIMEOUT IS NOT REQUIRED EITHER. Any work outliving the test body does it:
     * `idempotency.ts` fires its record write with a deliberate un-awaited `void db.insert(...)`
     * once the response is on the wire, and `request-log.ts` logs from `res.on("finish")`.
     * Raising a budget narrows the window and cannot close it.
     *
     * A SECOND, INDEPENDENT CAUSE was missing entirely: ~111 express-rate-limit MemoryStores,
     * one per limiter, created at import and never reset, all keyed by the one test user.
     * `commerce-trust.routes.test.ts` ran at 15 of 20 on one limiter and 8 of 10 on another.
     * That one flakes single-threaded, and is fixed — `src/test-support/rate-limit-reset.ts`,
     * called from every signing-in `beforeEach`. Verified by squeezing a limit to 2: the suite
     * fails without the reset and passes with it.
     *
     * THE SESSION HALF IS NARROWED, NOT CLOSED. `auth-mock.ts` now stamps the caller onto the
     * request at arrival, so a request that arrives in time cannot be answered with a later
     * test's identity. A request that ARRIVES late still can — supertest dispatches over a
     * real socket, and nothing here awaits an abandoned one. Closing that needs the suites to
     * await their own requests to completion.
     *
     * RULED OUT, by instrumenting all eleven per-suite `idempotency` stubs and running until a
     * failure fired: the residual `expected 400 to be 200` failures are NOT those stubs. The
     * probe printed nothing, and one such failure was on a GET, which never reaches
     * idempotency at all. That cause is still unidentified — do not assume it.
     */
    testTimeout: 20_000,
    /**
     * AND THE HOOKS, which carry a SEPARATE budget — 10 000 ms by default, untouched by
     * `testTimeout`. Raising only the test budget left this half open, and it showed: after that
     * change `src/app.test.ts` still failed roughly one run in ten, as a FAILED SUITE rather
     * than a failed assertion, because nearly every route suite builds its app in `beforeAll`
     * and that is the slowest thing any of them does.
     *
     * A suite-level failure is the more misleading of the two — it reports no assertion at all,
     * so it reads as the file being broken rather than as the machine being busy.
     */
    hookTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/types/**"],
    },
  },
  resolve: {
    alias: {
      "#src": new URL("./src", import.meta.url).pathname,
    },
  },
});
