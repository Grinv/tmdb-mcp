// Translate the bundle positions in a logged stack (dist/index.js:L:C) back to
// source lines. The shipped bundle has no sourcemap, but the build is
// reproducible, so rebuilding the same release with one yields a map for the
// exact bytes users ran (a sourcemap only appends a trailing comment):
//
//   git checkout vX.Y.Z && npm ci && npx tsdown --sourcemap
//   node scripts/decode-stack.ts dist/index.js.map < stderr.log
//
// Prints the log with each bundle frame rewritten; other lines pass through.
import { readFileSync } from "node:fs";
import { SourceMap } from "node:module";

const mapPath = process.argv[2];
if (!mapPath) {
  process.exitCode = 2;
  throw new TypeError("usage: node scripts/decode-stack.ts <dist/index.js.map> < log");
}
const map = new SourceMap(JSON.parse(readFileSync(mapPath, "utf8")));
const log = readFileSync(0, "utf8");

// Every bundle position (`file:///…/index.js:L:C`); Node's own frames
// (`node:internal/…`) have no `.js:` and pass through.
const decoded = log.replace(
  /(?:file:\/\/)?[^()\s]+\.js:(\d+):(\d+)/g,
  (position, line: string, column: string) => {
    const entry = map.findEntry(Number(line) - 1, Number(column) - 1);
    if (!("originalSource" in entry)) return position;
    const source = entry.originalSource.replace(/^.*?\/(src|node_modules)\//, "$1/");
    return `${source}:${entry.originalLine + 1}:${entry.originalColumn + 1}`;
  },
);
process.stdout.write(decoded);
