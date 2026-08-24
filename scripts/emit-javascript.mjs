import { mkdir, rm } from "node:fs/promises";
import { glob } from "node:fs/promises";
import path from "node:path";

import * as esbuild from "esbuild";

/**
 * Transpiles `src/` to `dist/` without typechecking.
 *
 * `tsc` loads the whole program into memory. This repo has hundreds of strict
 * TypeScript files, so that compile is killed by the kernel (SIGKILL / exit 137)
 * on a small Dokploy VPS. esbuild strips types file-by-file and peaks well under
 * 100 MB. Typechecking stays on `pnpm typecheck` / `pnpm build` locally and in CI.
 *
 * Imports are left as written (`#src/….js`, package names). Node resolves them at
 * runtime through package.json `"imports"` and node_modules — the same contract
 * `tsc`'s emit relies on.
 */
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(repositoryRoot, "src");
const outputRoot = path.join(repositoryRoot, "dist");

const entryPoints = [];
for await (const relativePath of glob("**/*.ts", { cwd: sourceRoot })) {
  if (relativePath.endsWith(".d.ts")) continue;
  if (relativePath.endsWith(".test.ts")) continue;
  if (relativePath.split(path.sep)[0] === "test-support") continue;
  entryPoints.push(path.join(sourceRoot, relativePath));
}

if (entryPoints.length === 0) {
  throw new Error("emit-javascript: no TypeScript files found under src/");
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

await esbuild.build({
  absWorkingDir: repositoryRoot,
  entryPoints,
  outdir: outputRoot,
  outbase: sourceRoot,
  format: "esm",
  platform: "node",
  target: "node24",
  packages: "external",
  sourcemap: false,
  logLevel: "info",
});
