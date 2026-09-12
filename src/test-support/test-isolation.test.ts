import { globSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * TWO INVARIANTS THAT KEEP ROUTE TESTS ISOLATED FROM EACH OTHER, both of which used to be
 * conventions nobody enforced, and one of which cost a month.
 *
 * ## THE BUG BEHIND THIS FILE
 *
 * `auth-mock.ts` has to keep the current caller in a module-level box, because `vi.mock`
 * factories are hoisted and cannot close over a per-test value. `getSession` read that box when
 * it RESOLVED — and a request can resolve after its own test has ended, by which time the next
 * `beforeEach` has run `signInAs()` or a neighbour has run `signOut()`. The request was then
 * answered with the WRONG test's identity, surfacing as `expected 401 to be 200` against a test
 * that had done nothing wrong, in roughly one shuffled run in five.
 *
 * `8fe09c2` fixed it by STAMPING the caller onto the request at arrival (`stampTestSession`,
 * mounted by `buildTestApp`) so the answer travels with the request. That commit was also
 * explicit about what it did not fix:
 *
 *   > It does nothing about the window before arrival: supertest dispatches over a real socket,
 *   > so a truly orphaned request can ARRIVE after the test boundary too, and the stamp then
 *   > records the next test's session exactly as the old box did. Closing it properly means the
 *   > suites awaiting their own requests to completion so an orphan cannot exist. That is
 *   > structural and not attempted here.
 *
 * This file is that structural part, plus a guard on the stamp itself.
 *
 * ## ⚠️ WHY NOT `typescript/no-floating-promises`, WHICH SOUNDS LIKE EXACTLY THIS
 *
 * Because it is BLIND to this case, which was measured rather than assumed. The rule is already
 * enabled — it is in oxlint's `correctness` category and `.oxlintrc.json` sets that to `error`,
 * with `typeAware: true` — and a probe file proved it flags a bare `Promise.resolve(1)` and does
 * NOT flag `request(app).get("/a");`, in any shape: chained, assigned, or plain. Supertest's
 * `Test` is a thenable (`superagent.Request` with a `.then`), not a `Promise`, so the rule's type
 * check does not recognise it. A guard that cannot see the thing it is named after is worse than
 * no guard, because it is believed.
 *
 * ## WHY THIS SCANS LINES, HAVING WANTED AN AST
 *
 * The shape being hunted is an expression statement whose value is discarded — `request(app)…;`
 * standing alone — as distinct from `await request(…)`, `return request(…)` or an arrow body
 * `=> request(…)`, all of which are fine. A parse tree separates those exactly and line shape
 * does not, so this should be an AST walk.
 *
 * IT CANNOT BE, and the reason is worth writing down so nobody retries it: this repo is on
 * TypeScript 7, the native port, whose JS module exports `version` and `versionMajorMinor` and
 * NOTHING ELSE — there is no `createSourceFile`, no `ScriptTarget`, no compiler API to call.
 * `@babel/parser` exists in the store but only as a transitive dependency, so importing it would
 * break on any lockfile change, and adding a parser as a direct dependency to police three lines
 * of test style is not a trade worth making.
 *
 * So: one heuristic, one exemption, and the exemption is the only thing standing between this
 * and two false positives. A line whose first token is `request(` is a discarded request UNLESS
 * the previous non-blank line ends in `=>`, which makes it an arrow body returning the request —
 * exactly the `startSignup`/`completeSignup` helpers at `rate-limit.test.ts:78,81`. Everything
 * legitimate (`await`, `return`, `const x =`, `Promise.all([`) puts a token before `request(` on
 * the same line and is never matched at all.
 *
 * What it cannot see: a discarded request inside a comment or a template literal. Accepted.
 */

const REPOSITORY_ROOT = join(import.meta.dirname, "..", "..");

/**
 * `src/app.js` reached without `buildTestApp` means a request that never passes
 * `stampTestSession`, so `getSession` falls back to the module box — the original race, restored
 * in full. These three files do it today and use no session at all, which is why they are listed
 * rather than fixed: the point is that the list cannot grow silently.
 */
const UNSTAMPED_APP_FILES_WITHOUT_A_SESSION: readonly string[] = [
  "src/app.test.ts",
  "src/middleware/json-body-budget.test.ts",
  "src/middleware/rate-limit.test.ts",
];

/**
 * `node:fs`'s own `globSync` rather than the `glob` package — this needs no new dependency, and
 * a test-isolation guard that pulled one in would be its own small irony.
 */
function readTestSources(): readonly { path: string; source: string }[] {
  const paths = globSync("src/**/*.test.ts", { cwd: REPOSITORY_ROOT });
  return paths
    .map((path) => path.replaceAll("\\", "/"))
    .toSorted()
    .map((path) => ({ path, source: readFileSync(join(REPOSITORY_ROOT, path), "utf8") }));
}

/**
 * Every discarded `request(…)` statement, as `file:line`.
 *
 * See the heuristic and its single exemption in this file's header comment.
 */
function findDiscardedRequests(path: string, source: string): readonly string[] {
  const lines = source.split("\n");
  const discarded: string[] = [];

  for (const [index, line] of lines.entries()) {
    if (!/^\s*request\(/.test(line)) continue;

    // The nearest preceding line with anything on it. An arrow body sits under its own `=>`.
    const previousMeaningfulLine = lines
      .slice(0, index)
      .reverse()
      .find((candidate) => candidate.trim().length > 0);
    if (previousMeaningfulLine?.trimEnd().endsWith("=>") === true) continue;

    discarded.push(`${path}:${String(index + 1)}`);
  }

  return discarded;
}

describe("route-test isolation", () => {
  /**
   * ⚠️ THE ORPHAN GUARD. A discarded request is one nobody awaits, so it can still be in flight
   * when its test ends — and it is then stamped with whichever session the NEXT test installed.
   */
  it("never discards a supertest request, so none can outlive its test", () => {
    const sources = readTestSources();
    const discarded = sources.flatMap(({ path, source }) => findDiscardedRequests(path, source));

    /*
     * THE DENOMINATOR, asserted first and for the reason `rate-limit-coverage.test.ts:396`
     * asserts its own: a glob that silently matched nothing would make the check below green
     * while proving exactly nothing. This is the number that makes the emptiness mean something.
     */
    expect(sources.length).toBeGreaterThan(180);
    expect(discarded).toEqual([]);
  });

  /**
   * THE STAMP GUARD. A suite that speaks as a signed-in caller must go through `buildTestApp`,
   * because that is what mounts `stampTestSession`.
   */
  it("only uses a session in a suite that mounts the stamp", () => {
    const sources = readTestSources();
    const unstamped: string[] = [];
    let sessionUsingFileCount = 0;

    for (const { path, source } of sources) {
      const usesSession = /\bsign(InAs|Out)\s*\(/.test(source);
      if (usesSession) sessionUsingFileCount += 1;

      const reachesAppDirectly = source.includes('import("#src/app.js")');
      if (usesSession && reachesAppDirectly && !source.includes("buildTestApp")) {
        unstamped.push(relative(".", path));
      }
    }

    // Same reasoning as above: if the detector stopped matching, this is what fails.
    expect(sessionUsingFileCount).toBeGreaterThan(50);
    expect(unstamped).toEqual([]);
  });

  /**
   * The other direction, so the list at the top of this file cannot rot into a lie. A file that
   * grows a `signInAs` is caught by the case above; a file that gains `buildTestApp`, or is
   * deleted, should be removed from the list rather than left as folklore.
   */
  it("keeps the unstamped-file list honest", () => {
    const sources = readTestSources();
    const byPath = new Map(sources.map(({ path, source }) => [path, source]));

    const stale = UNSTAMPED_APP_FILES_WITHOUT_A_SESSION.filter((path) => {
      const source = byPath.get(path);
      return source === undefined || source.includes("buildTestApp");
    });

    expect(stale).toEqual([]);
  });
});
