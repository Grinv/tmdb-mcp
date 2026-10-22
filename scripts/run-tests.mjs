// Cross-platform test runner: runs `node --test` with the working directory set
// to dist-tests (where compiled *.test.js + their imports live). Avoids the
// POSIX-only `(cd dir && ...)` shell idiom so it works on Windows cmd.exe too.
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
  // `--test-coverage-lines` (Node 22.8+, below the 22.13 floor) fails the run
  // when line coverage drops under the threshold.
  args.push("--experimental-test-coverage", `--test-coverage-lines=${COVERAGE_LINES_THRESHOLD}`);
}

const child = spawn(process.execPath, args, { cwd: "dist-tests", stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
