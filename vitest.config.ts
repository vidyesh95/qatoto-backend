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
