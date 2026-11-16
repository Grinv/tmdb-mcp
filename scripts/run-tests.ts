// Cross-platform test runner: runs `node --test` straight on src/**/*.test.ts
// via Node's built-in type stripping (on by default since 22.18), so there's
// no transpile step. Passing the glob ourselves (rather than a shell glob in
// package.json) keeps it working on Windows cmd.exe too.
import { spawn } from "node:child_process";
import { existsSync, globSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

// Keep this in sync with the CI "Coverage gate" step (.github/workflows/ci.yml).
const COVERAGE_LINES_THRESHOLD = 80;

const rawArgs = process.argv.slice(2);
const coverage = rawArgs.includes("--coverage");
// Forward any other CLI arg straight through to `node --test`, so
// `npm test -- --test-name-pattern=foo` or `npm test -- src/__tests__/omdb.test.ts`
// works locally.
const passthrough = rawArgs.filter((a) => a !== "--coverage");
// An arg that names files on disk (a path, or a glob that matches some)
// means the caller picked its own tests; only fall back to the whole suite
// without one. Checked against the disk because neither position nor shape
// tells a file from a flag's value: `--test-only x.test.ts` vs
// `--test-name-pattern "cache*"`.
const namesFiles = passthrough.some(
  (a) => !a.startsWith("-") && (existsSync(join(root, a)) || globSync(a, { cwd: root }).length > 0),
);

const args = ["--test"];
if (coverage) {
  // `--test-coverage-lines` (Node 22.8+, below the 22.18 floor) fails the run
  // when line coverage drops under the threshold. Measure src/ only: tests
  // also import scripts/sync-version.ts, which isn't what the gate is about.
  args.push(
    "--experimental-test-coverage",
    `--test-coverage-lines=${COVERAGE_LINES_THRESHOLD}`,
    "--test-coverage-include=src/**",
    // Test files and their helpers aren't what the gate measures.
    "--test-coverage-exclude=src/__tests__/**",
  );
}
// Our own flags go first and file patterns last: Node treats every argument
// after the first positional one as a file pattern, so a flag placed after it
// is silently ignored (e.g. the coverage gate above would never run).
args.push(...passthrough);
if (!namesFiles) args.push("src/**/*.test.ts");

// Anchor at the repo root so the relative globs resolve the same wherever
// this script is invoked from.
const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
