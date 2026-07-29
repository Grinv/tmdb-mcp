import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../version.js";
import { connectServer, DEFAULT_ENV } from "./helpers.js";
import { renderChangelogRelease } from "../../scripts/sync-version.mjs";

// Tests run from the dist-tests/ working directory; the repo root is one level up.
const root = join(process.cwd(), "..");
const readJson = (rel: string) => JSON.parse(readFileSync(join(root, rel), "utf8"));

const pkg = readJson("package.json") as { version: string; mcpName: string };
const manifest = readJson("manifest.json") as {
  version: string;
  user_config: Record<string, unknown>;
  tools: { name: string }[];
  prompts: { name: string; description: string; arguments: string[] }[];
};
const server = readJson("server.json") as {
  name: string;
  description: string;
  version: string;
  packages: {
    registryType: string;
    version: string;
    identifier: string;
    environmentVariables?: { name: string; description: string }[];
  }[];
};

// package.json is the single source of truth; scripts/sync-version.mjs (the npm
// `version` hook) propagates it everywhere below. These assertions fail loudly
// if any file drifts — including a hand-edit that bypassed the hook.
describe("release metadata stays in sync with package.json", () => {
  test("VERSION constant matches package.json", () => {
    assert.equal(VERSION, pkg.version);
  });

  test("manifest.json version matches package.json", () => {
    assert.equal(manifest.version, pkg.version);
  });

  test("server.json versions (+ mcpb release URL) match package.json", () => {
    assert.equal(server.version, pkg.version);
    for (const p of server.packages) assert.equal(p.version, pkg.version);
    // The .mcpb asset URL is version-pinned; the npm identifier is not.
    const mcpb = server.packages.find((p) => p.registryType === "mcpb");
    assert.ok(mcpb, "server.json has an mcpb package");
    assert.match(mcpb.identifier, new RegExp(`/v${pkg.version}/`));
  });

  // The MCP Registry verifies npm ownership by matching package.json's mcpName to
  // the published server name, so these must stay identical.
  test("package.json mcpName matches server.json name", () => {
    assert.equal(pkg.mcpName, server.name);
  });

  // The MCP Registry server.schema caps description at 100 chars (npm/manifest
  // have no such limit, so server.json's may differ from package.json's).
  test("server.json description fits the MCP Registry 100-char limit", () => {
    assert.ok(
      server.description.length <= 100,
      `server.json description is ${server.description.length} chars (max 100)`,
    );
  });

  // scripts/sync-version.mjs moves CHANGELOG.md's [Unreleased] notes under a
  // "## [x.y.z] - <date>" heading as part of every version bump (atomically
  // with bumping package.json itself), so this heading must always exist for
  // the current version — a v0.9.0 release once shipped with this heading
  // missing entirely (package.json/manifest/server.json all said 0.9.0, but
  // CHANGELOG.md still said "Unreleased"), caught by nothing until a human
  // happened to notice.
  test("CHANGELOG.md has a heading for the current version", () => {
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    assert.match(
      changelog,
      new RegExp(`^## \\[${pkg.version.replace(/\./g, "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m"),
      `CHANGELOG.md has no "## [${pkg.version}] - <date>" heading`,
    );
  });
});

// Guards the pure string-transform sync-version.mjs uses to file [Unreleased]
// under a dated version heading — the exact mechanism the "CHANGELOG.md has a
// heading for the current version" test above verifies end-to-end.
describe("renderChangelogRelease", () => {
  test("renames Unreleased and reopens a fresh empty section above it", () => {
    const fixture =
      "## [Unreleased]\n\n### Fixed\n\n- Something ([abc1234](https://example.com)).\n\n" +
      "## [0.9.0] - 2026-07-29\n\n### Added\n\n- Old thing.\n";

    const out = renderChangelogRelease(fixture, "0.10.0", "2026-08-01");

    assert.match(out, /## \[Unreleased\]\n\n## \[0\.10\.0\] - 2026-08-01\n/);
    assert.match(out, /## \[0\.10\.0\][\s\S]*- Something/);
    // The prior version's own section is untouched.
    assert.match(out, /## \[0\.9\.0\] - 2026-07-29\n\n### Added\n\n- Old thing\./);
  });

  test("is a no-op when [Unreleased] has no bullets (idempotent re-run / no-user-facing-change release)", () => {
    const fixture = "## [Unreleased]\n\n## [0.9.0] - 2026-07-29\n\n### Added\n\n- Old thing.\n";
    assert.equal(renderChangelogRelease(fixture, "0.10.0", "2026-08-01"), fixture);
  });

  test("is a no-op when [Unreleased] has only blank lines before the next heading", () => {
    const fixture = "## [Unreleased]\n\n\n## [0.9.0] - 2026-07-29\n\n- Old thing.\n";
    assert.equal(renderChangelogRelease(fixture, "0.10.0", "2026-08-01"), fixture);
  });

  test("throws if the Unreleased heading is missing entirely", () => {
    assert.throws(() =>
      renderChangelogRelease("## [0.10.0] - 2026-08-01\n", "0.11.0", "2026-09-01"),
    );
  });
});

describe("manifest.json/server.json stay in sync with the running server", () => {
  // User-facing config is declared in both manifest.json (the .mcpb install form)
  // and server.json (the registry entry). They must list the same variables, so a
  // new/renamed config option can't silently land in one but not the other.
  // (config.ts is the upstream source; AGENTS.md covers keeping it in sync too.)
  test("server.json environmentVariables match manifest.json user_config", () => {
    const expected = new Set(Object.keys(manifest.user_config).map((k) => k.toUpperCase()));
    for (const p of server.packages) {
      const got = new Set((p.environmentVariables ?? []).map((e) => e.name));
      assert.deepEqual(
        got,
        expected,
        `package ${p.registryType} environmentVariables must match manifest user_config`,
      );
    }
    // Registry schema caps each description at 100 chars too.
    for (const p of server.packages)
      for (const e of p.environmentVariables ?? [])
        assert.ok(
          e.description.length <= 100,
          `${e.name} description is ${e.description.length} > 100`,
        );
  });

  // manifest.json's `tools`/`prompts` arrays (the .mcpb install preview) are a
  // hand-maintained copy of what the server actually registers — nothing keeps
  // them in sync automatically, so a renamed/added/removed tool or prompt, or a
  // prompt whose description/args drifted from src/prompts.ts, would go
  // unnoticed without this. Both loop over whatever is currently registered, so
  // adding a second/third prompt or tool needs no new test. Names only for
  // tools (their manifest description is an intentionally short catalog blurb,
  // not a copy of the full tool description).
  //
  // Together with e2e.test.ts (which checks the real built dist/index.js's tool
  // count against manifest.tools.length), this closes the triangle: built
  // binary count === manifest.json count === in-memory server names (a strictly
  // stronger check than count, since it also catches a rename/swap).
  test("manifest.json tools list matches the server's registered tools", async (t) => {
    const { client, close } = await connectServer(DEFAULT_ENV);
    t.after(close);
    const { tools } = await client.listTools();
    const serverToolCount = tools.length;
    assert.equal(
      serverToolCount,
      manifest.tools.length,
      "manifest.json's tool count drifted from the server's registered tools",
    );
    assert.deepEqual(tools.map((tl) => tl.name).sort(), manifest.tools.map((tl) => tl.name).sort());
  });

  test("manifest.json's prompts match every registered prompt", async (t) => {
    const { client, close } = await connectServer(DEFAULT_ENV);
    t.after(close);
    const { prompts } = await client.listPrompts();
    // Same name set first (catches an added/removed/renamed prompt regardless
    // of how many there are), then description + argument names per prompt.
    assert.deepEqual(prompts.map((p) => p.name).sort(), manifest.prompts.map((p) => p.name).sort());
    for (const registered of prompts) {
      const manifestPrompt = manifest.prompts.find((p) => p.name === registered.name)!;
      assert.equal(
        registered.description,
        manifestPrompt.description,
        `${registered.name} description drifted from manifest.json`,
      );
      assert.deepEqual(
        (registered.arguments ?? []).map((a) => a.name).sort(),
        manifestPrompt.arguments.slice().sort(),
        `${registered.name} arguments drifted from manifest.json`,
      );
    }
  });
});
