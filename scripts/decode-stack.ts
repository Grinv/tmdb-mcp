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
  console.error("usage: node scripts/decode-stack.ts <dist/index.js.map> < log");
  process.exit(2);
}
const map = new SourceMap(JSON.parse(readFileSync(mapPath, "utf8")));
const log = readFileSync(0, "utf8");

// Only the bundle's own positions (`…/dist/index.js:L:C`); any other file's frames
// pass through, and so does a position the map has no entry for on that line
// (findEntry would otherwise answer with the nearest earlier line's mapping).
const decoded = log.replace(
  /(?:file:\/\/)?[^()\s]*\/dist\/index\.js:(\d+):(\d+)/g,
  (position, line: string, column: string) => {
    const entry = map.findEntry(Number(line) - 1, Number(column) - 1);
    if (!("originalSource" in entry) || entry.generatedLine !== Number(line) - 1) {
      return position;
    }
    const source = entry.originalSource.replace(/^.*?\/(src|node_modules)\//, "$1/");
    return `${source}:${entry.originalLine + 1}:${entry.originalColumn + 1}`;
  },
);
process.stdout.write(decoded);
