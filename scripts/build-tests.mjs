// Transpile every src/**/*.ts (tests + sources) to dist-tests/ as ESM,
// preserving the directory layout so relative ".js" imports resolve.
// Decoupled from the runtime: lets `node --test` run on any Node >=20
// regardless of native TS type-stripping support.
import { build } from "esbuild";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const SRC = "src";
const OUT_DIR = "dist-tests";

/** @returns {string[]} all .ts files under dir (recursive) */
function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

// esbuild's outdir never removes stale output for deleted/renamed source
// files, so a renamed/deleted test file would leave its old compiled .js
// behind here, and `node --test dist-tests` would silently keep running it.
// Start from a clean slate every time.
rmSync(OUT_DIR, { recursive: true, force: true });

await build({
  entryPoints: collect(SRC),
  outdir: OUT_DIR,
  outbase: SRC,
  bundle: false,
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: true,
});
