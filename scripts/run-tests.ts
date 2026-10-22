// Cross-platform test runner: runs `node --test` straight on src/**/*.test.ts
// via Node's built-in type stripping (on by default since 22.18), so there's
// no transpile step. Passing the glob ourselves (rather than a shell glob in
// package.json) keeps it working on Windows cmd.exe too.
import { spawn } from "node:child_process";
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
// A positional arg means the caller named its own test files; only fall back
// to the whole suite without one. An arg right after a `--flag` with no `=`
// is taken as that flag's value (`--test-name-pattern foo`), not a file.
const namesFiles = passthrough.some(
  (a, i) => !a.startsWith("-") && !/^--[^=]+$/.test(passthrough[i - 1] ?? ""),
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
