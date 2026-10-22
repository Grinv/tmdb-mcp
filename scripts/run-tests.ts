// Cross-platform test runner: runs `node --test` straight on src/**/*.test.ts
// via Node's built-in type stripping (on by default since 22.18), so there's
// no transpile step. Passing the glob ourselves (rather than a shell glob in
// package.json) keeps it working on Windows cmd.exe too.
import { spawn } from "node:child_process";

// Keep this in sync with the CI "Coverage gate" step (.github/workflows/ci.yml).
const COVERAGE_LINES_THRESHOLD = 80;

const rawArgs = process.argv.slice(2);
const coverage = rawArgs.includes("--coverage");
// Forward any other CLI arg (e.g. --test-name-pattern=foo) straight through to
// `node --test`, so `npm test -- --test-name-pattern=foo` works locally.
const passthrough = rawArgs.filter((a) => a !== "--coverage");

const args = ["--test", ...passthrough];
if (coverage) {
  // `--test-coverage-lines` (Node 22.8+, below the 22.18 floor) fails the run
  // when line coverage drops under the threshold.
  args.push("--experimental-test-coverage", `--test-coverage-lines=${COVERAGE_LINES_THRESHOLD}`);
}
// The test-file glob must come last: Node treats every argument after the
// first positional one as a file pattern, so a flag placed after it is
// silently ignored (e.g. the coverage gate above would never run).
args.push("src/**/*.test.ts");

const child = spawn(process.execPath, args, { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
