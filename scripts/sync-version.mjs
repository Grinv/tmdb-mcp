// Propagate the version from package.json (the single source of truth) into the
// other files that must carry it: src/version.ts, manifest.json (.mcpb bundle),
// server.json (MCP registry, incl. the release-asset URL), and CHANGELOG.md
// (moves [Unreleased]'s notes under a new dated version heading). Wired into
// the npm `version` lifecycle hook (see package.json), so `npm version <bump>`
// updates every file in one commit — this used to be a manual step ("move
// Unreleased notes under X.Y.Z") that was easy to forget, or to do in the
// wrong order relative to `npm version` itself; automating it here removes
// that failure mode entirely. Uses targeted token replacement — not JSON
// re-serialization — to preserve each file's exact formatting.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function patch(rel, edits) {
  const file = join(root, rel);
  let text = readFileSync(file, "utf8");
  for (const [pattern, replacement] of edits) {
    if (!text.match(pattern)) {
      throw new Error(`sync-version: pattern ${pattern} not found in ${rel} — update the script`);
    }
    text = text.replace(pattern, replacement);
  }
  writeFileSync(file, text);
}

// The leading quote means this never matches `"manifest_version"` in manifest.json.
const versionField = /("version":\s*")[^"]*(")/;

patch("src/version.ts", [[/(export const VERSION = ")[^"]*(")/, `$1${version}$2`]]);
patch("manifest.json", [[versionField, `$1${version}$2`]]);
patch("server.json", [
  [new RegExp(versionField, "g"), `$1${version}$2`], // top-level + package version
  [/(releases\/download\/v)\d+\.\d+\.\d+(\/)/, `$1${version}$2`], // .mcpb asset URL tag
]);

// Move CHANGELOG.md's [Unreleased] notes under a new "## [x.y.z] - <date>"
// heading, leaving [Unreleased] itself empty — mirrors what used to be a
// separate manual "docs: move Unreleased notes under X.Y.Z" commit. Skipped
// (not an error) if [Unreleased] is already empty/already-headed, so this is
// safe to run more than once and doesn't fight CONFIRM_EMPTY_CHANGELOG=1
// releases (preversion-check.mjs already gates those).
function syncChangelog() {
  const rel = "CHANGELOG.md";
  const file = join(root, rel);
  const text = readFileSync(file, "utf8");
  const marker = "## [Unreleased]\n";
  const idx = text.indexOf(marker);
  if (idx === -1) {
    throw new Error(`sync-version: '${marker.trim()}' heading not found in ${rel}`);
  }
  const afterMarker = text.slice(idx + marker.length);
  if (/^\s*## \[/.test(afterMarker)) {
    console.log(`sync-version: ${rel}'s [Unreleased] is already empty — leaving as-is`);
    return;
  }
  const date = new Date().toISOString().slice(0, 10);
  const heading = `\n## [${version}] - ${date}\n`;
  writeFileSync(file, text.slice(0, idx + marker.length) + heading + afterMarker);
  console.log(`sync-version: moved ${rel}'s Unreleased notes under [${version}] - ${date}`);
}
syncChangelog();

console.log(`sync-version: set ${version} in version.ts, manifest.json, server.json`);
