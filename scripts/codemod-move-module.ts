import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Rewrites every reference to a file that `git mv` has just staged.
 *
 * HOW TO USE IT. Stage the moves, then run this — it asks git what moved rather than
 * taking a hand-written map:
 *
 *     git mv src/routes/playlists.routes.ts src/modules/studio/playlists/
 *     pnpm codemod:move
 *     pnpm fmt && pnpm check:specifiers && pnpm typecheck && pnpm test
 *
 * WHY THE MAP COMES FROM GIT. `git diff --cached -M100%` reports a rename only when the
 * content is byte-identical, which `git mv` guarantees. If a path is missing from the map,
 * the file was EDITED as well as moved — and that is a commit that has to be split, not a
 * codemod input. A hand-written map cannot tell you that.
 *
 * WHY NOT ts-morph. Most of what has to change is not an import declaration:
 *
 *   - ~199 `vi.mock("#src/...")` calls and the `await import(...)` forms are strings.
 *   - `rate-limit-coverage.test.ts` holds 45 route specifiers as data in an array.
 *   - ~1,966 in-comment path references, and 139 more in docs/*.md. This codebase's
 *     comments ARE its documentation; leaving them pointing at directories that no longer
 *     exist is the real cost of a move, and it is avoidable for free because the map is
 *     already in hand.
 *
 * Both spellings are rewritten: the `#src` subpath specifier, and the bare repo-relative
 * path that appears in prose.
 *
 * LONGEST KEY FIRST, always. This repo has real prefix collisions — `lib/geo` inside
 * `lib/geocoding`, `middleware/json-body` inside `json-body-budget`, `middleware/rate-limit`
 * inside `rate-limit-store`, `docs/openapi` inside `openapi-rnd` inside
 * `openapi-rnd-bodies`. Replacing in map order corrupts the longer path.
 */

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");

/** Extra files that carry `src/...` paths and would otherwise go stale. */
const PROSE_TARGETS = ["CLAUDE.md", "AGENTS.md", ".oxlintrc.json"];

interface Rename {
  readonly from: string;
  readonly to: string;
}

function git(...args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
}

function readStagedRenames(): readonly Rename[] {
  const staged = git("diff", "--cached", "-M100%", "--name-status", "--diff-filter=R");
  return staged
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [, from, to] = line.split("\t");
      if (from === undefined || to === undefined) throw new Error(`unparsable rename: ${line}`);
      return { from, to };
    });
}

/** `src/a/b.ts` -> the two spellings that appear in the tree. */
function replacementsFor(renames: readonly Rename[]): ReadonlyMap<string, string> {
  const replacements = new Map<string, string>();
  for (const { from, to } of renames) {
    const fromStem = from.replace(/^src\//, "").replace(/\.ts$/, "");
    const toStem = to.replace(/^src\//, "").replace(/\.ts$/, "");
    replacements.set(`#src/${fromStem}.js`, `#src/${toStem}.js`);
    replacements.set(from, to);
  }
  return replacements;
}

function buildPattern(replacements: ReadonlyMap<string, string>): RegExp {
  const keys = [...replacements.keys()].toSorted((left, right) => right.length - left.length);
  const escaped = keys.map((key) => key.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`));
  return new RegExp(`(${escaped.join("|")})`, "g");
}

function listTargets(): readonly string[] {
  const tracked = git("ls-files", "--", "src", "scripts", "docs").split("\n").filter(Boolean);
  return [...tracked.filter((file) => /\.(ts|md)$/.test(file)), ...PROSE_TARGETS];
}

const renames = readStagedRenames();
if (renames.length === 0) {
  console.error(
    "codemod:move — no staged renames.\n" +
      "Stage the moves with `git mv` first. If a file you moved is missing here, it was\n" +
      "edited as well as moved: separate the two, or -M100% will not see it as a rename.",
  );
  process.exit(1);
}

const replacements = replacementsFor(renames);
const pattern = buildPattern(replacements);

console.log(`codemod:move — ${renames.length} rename(s):`);
for (const { from, to } of renames) console.log(`  ${from}\n    -> ${to}`);

let rewrittenFiles = 0;
let rewrittenReferences = 0;

await Promise.all(
  listTargets().map(async (target) => {
    const absolute = path.join(REPOSITORY_ROOT, target);
    // Read as bytes-to-utf8 with no binary heuristic: two source files embed a literal NUL
    // and grep-based tooling skips them silently. See scripts/check-src-specifiers.ts.
    let contents: string;
    try {
      contents = await readFile(absolute, "utf8");
    } catch {
      return;
    }

    let hits = 0;
    const rewritten = contents.replaceAll(pattern, (matched) => {
      hits += 1;
      return replacements.get(matched) ?? matched;
    });

    if (hits === 0) return;
    await writeFile(absolute, rewritten, "utf8");
    rewrittenFiles += 1;
    rewrittenReferences += hits;
  }),
);

console.log(`\nrewrote ${rewrittenReferences} reference(s) across ${rewrittenFiles} file(s).`);
console.log("next: pnpm fmt && pnpm check:specifiers && pnpm typecheck && pnpm test");
