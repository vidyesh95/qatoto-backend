import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Proves that every `#src/...` specifier in the repository resolves to a file that exists.
 *
 * WHY `tsc` IS NOT ENOUGH, which is the whole reason this exists. TypeScript checks import
 * DECLARATIONS. A large number of specifiers in this repo are not declarations — they are
 * strings:
 *
 *   - ~199 `vi.mock("#src/...")` calls. A missed one does not fail the build; it silently
 *     stops mocking, and the test then runs against a real database module.
 *   - `src/middleware/rate-limit-coverage.test.ts` holds 45 route specifiers as DATA in an
 *     array, loaded through a variable `await import(specifier)`.
 *   - `await import("#src/app.js")` and `typeof import("#src/docs/zod-to-openapi.js")`
 *     forms scattered through the test suites.
 *
 * `pnpm test` catches these eventually. This catches them in about two seconds, which is
 * what makes it usable as a pre-commit gate during a file-moving refactor.
 *
 * FILES ARE READ AS BYTES, DELIBERATELY. `src/lib/commerce-pricing.ts` and
 * `src/services/verification.service.ts` embed a literal NUL (`\x00`) as a SQL
 * expression-index delimiter, and `grep`/`rg` classify both as binary and skip them
 * WITHOUT SAYING SO — ten real specifiers, silently unchecked, in a checker that reports
 * success. Node's reader has no such heuristic. Do not reimplement this on top of grep.
 */

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const SPECIFIER_PATTERN = /["'`](#src\/[^"'`]+)["'`]/g;

interface DanglingSpecifier {
  readonly specifier: string;
  readonly sourceFile: string;
}

/**
 * `#src/x/y.js` maps to `src/x/y.ts` under the "development" condition of package.json's
 * imports map — the branch every non-built run takes. A directory import is not legal
 * here (NodeNext requires the extension), so the mapping is exactly one candidate.
 */
function resolveSpecifierToSourcePath(specifier: string): string {
  return path.join(REPOSITORY_ROOT, specifier.replace(/^#src\//, "src/").replace(/\.js$/, ".ts"));
}

function listTrackedTypeScriptFiles(): readonly string[] {
  const tracked = execFileSync("git", ["ls-files", "--", "src", "scripts"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  });
  return tracked.split("\n").filter((file) => file.endsWith(".ts"));
}

async function findDanglingSpecifiers(): Promise<readonly DanglingSpecifier[]> {
  const dangling: DanglingSpecifier[] = [];

  await Promise.all(
    listTrackedTypeScriptFiles().map(async (sourceFile) => {
      const contents = await readFile(path.join(REPOSITORY_ROOT, sourceFile), "utf8");
      for (const match of contents.matchAll(SPECIFIER_PATTERN)) {
        const specifier = match[1];
        if (specifier === undefined) continue;
        // `#src/*` and `#src/docs/*` appear in prose describing the subpath map itself. A
        // real specifier never carries a wildcard — the map resolves it, callers write the
        // concrete path — so this excludes the documentation without weakening the check.
        if (specifier.includes("*")) continue;
        if (existsSync(resolveSpecifierToSourcePath(specifier))) continue;
        dangling.push({ specifier, sourceFile });
      }
    }),
  );

  return dangling.toSorted(
    (left, right) =>
      left.sourceFile.localeCompare(right.sourceFile) ||
      left.specifier.localeCompare(right.specifier),
  );
}

const dangling = await findDanglingSpecifiers();

if (dangling.length === 0) {
  console.log("check:specifiers — every #src specifier resolves.");
} else {
  console.error(`check:specifiers — ${dangling.length} specifier(s) point at nothing:\n`);
  for (const { sourceFile, specifier } of dangling) {
    console.error(`  ${sourceFile}: ${specifier}`);
  }
  console.error(
    "\nA moved file left a specifier behind. Note that tsc cannot see the vi.mock() and\n" +
      "dynamic-import forms, so a green typecheck does not clear this.",
  );
  process.exitCode = 1;
}
