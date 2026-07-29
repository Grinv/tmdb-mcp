import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, copyFileSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { z } from "zod";

// The unit suite exercises the code via an in-memory transport against src. This
// e2e instead drives the REAL built bundle the way Claude Desktop does: a spawned
// `node dist/index.js` over stdio, run from an isolated dir with NO node_modules.
// It guards the integration boundary that earlier shipped bugs hid in — the bundle
// must start, complete the initialize handshake, register every tool, and run
// self-contained (a non-inlined dep would crash the child with ERR_MODULE_NOT_FOUND).
const root = join(process.cwd(), "..");
const distPath = join(root, "dist", "index.js");
// Tool count comes from manifest.json (itself checked against the in-memory
// server's registered tools in version.test.ts) instead of a hardcoded number
// that would silently go stale the next time a tool is added or removed.
const manifestToolCount = (
  JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as {
    tools: unknown[];
  }
).tools.length;

// A tiny local stand-in for TMDB (real node:http, not a fetch mock — the
// spawned child below is a separate OS process, so an in-process fetch mock
// can't reach it). Lets the cross-era checklist below prove REAL successful
// tool calls round-trip correctly under both protocol eras, not just the
// "not configured" error path the tests above exercise, without hitting the
// live network. Serves movie 603; any other id (e.g. 999, used as the
// deliberately-missing id in the checklist's batch case) falls through to
// the catch-all 404.
const MOCK_MOVIE = {
  id: 603,
  imdb_id: "tt0133093",
  title: "The Matrix",
  original_title: "The Matrix",
  overview: "A hacker learns the truth.",
  release_date: "1999-03-30",
  runtime: 136,
  status: "Released",
  genres: [{ id: 28, name: "Action" }],
  vote_average: 8.2,
  vote_count: 25000,
  origin_country: ["US"],
  release_dates: {
    results: [{ iso_3166_1: "US", release_dates: [{ certification: "R", type: 3 }] }],
  },
};

async function startMockTmdb(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/3/movie/603")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(MOCK_MOVIE));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address from the mock TMDB server");
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}/3` };
}

describe("e2e: built bundle", () => {
  test("runs standalone, handshakes, lists all tools, gates TMDB tools", async (t) => {
    if (!existsSync(distPath)) {
      t.skip("dist/index.js not built — run `npm run build` first (CI builds before tests)");
      return;
    }

    // Copy the bundle to a dir with no node_modules: if it weren't self-contained,
    // the child would die with ERR_MODULE_NOT_FOUND and connect() would reject.
    const sandbox = join(tmpdir(), `tmdb-mcp-e2e-${process.pid}`);
    mkdirSync(sandbox, { recursive: true });
    copyFileSync(distPath, join(sandbox, "index.js"));
    // The bundle is ESM; ship the package.json that flags it as such, exactly as
    // the real npm/.mcpb artifact does. Without it a bare `.js` is parsed as CJS
    // on Node < 20.19 (which lacks ESM syntax auto-detection) and the child dies
    // with "Cannot use import statement outside a module".
    writeFileSync(join(sandbox, "package.json"), JSON.stringify({ type: "module" }));

    // Inherit env but force the credentials unset, to test the config gate.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env))
      if (v !== undefined && k !== "TMDB_API_TOKEN" && k !== "OMDB_API_KEY") env[k] = v;

    const client = new Client({ name: "e2e", version: "0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(sandbox, "index.js")],
      env,
    });

    try {
      await client.connect(transport); // real initialize handshake over a spawned process

      // Paired with version.test.ts's in-memory name check: that one proves
      // manifest.json's tool names match buildServer()'s (a strictly stronger
      // check than count, since it also catches a rename/swap); this proves the
      // real built bundle registers the same *count* — together, built binary
      // count === manifest.json count === in-memory server names.
      const { tools } = await client.listTools();
      assert.equal(
        tools.length,
        manifestToolCount,
        "every tool listed in manifest.json should register in the built bundle",
      );

      // A TMDB tool without a token must short-circuit with the actionable message
      // (no network) — proving the config gate works through the real binary.
      const res = await client.callTool({ name: "get_movie", arguments: { id: 550 } });
      assert.equal(res.isError, true);
      const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
      assert.match(text, /TMDB is not configured/i);
    } finally {
      await client.close();
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  // The unit suite's InMemoryTransport connects via a bare `server.connect()`,
  // which — per the SDK's own design (era is instance state, set at construction
  // by a serving entry point) — only ever binds the legacy 2025-era handshake;
  // it cannot exercise protocol revision 2026-07-28 no matter what the client
  // requests. Only `serveStdio` (used by src/server.ts's start(), and thus the
  // real spawned binary here) marks an instance modern, so this is the one place
  // that can prove the modern era actually works end to end.
  test("negotiates protocol revision 2026-07-28 and serves tools under it", async (t) => {
    if (!existsSync(distPath)) {
      t.skip("dist/index.js not built — run `npm run build` first (CI builds before tests)");
      return;
    }

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env))
      if (v !== undefined && k !== "TMDB_API_TOKEN" && k !== "OMDB_API_KEY") env[k] = v;

    const client = new Client(
      { name: "e2e-modern", version: "0" },
      { versionNegotiation: { mode: "auto" } },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distPath],
      env,
    });

    try {
      await client.connect(transport);
      assert.equal(client.getNegotiatedProtocolVersion?.(), "2026-07-28");

      // tools/call still round-trips correctly under the modern wire codec, and
      // the config gate still fires (no network, same as the legacy-era test above).
      const res = await client.callTool({ name: "get_movie", arguments: { id: 550 } });
      assert.equal(res.isError, true);
      const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
      assert.match(text, /TMDB is not configured/i);
    } finally {
      await client.close();
    }
  });
});

interface EraConfig {
  label: string;
  expectedProtocolVersion: string;
  clientOptions?: { versionNegotiation: { mode: "auto" } };
}

const ERAS: EraConfig[] = [
  { label: "legacy (2025-era, default negotiation)", expectedProtocolVersion: "2025-11-25" },
  {
    label: "modern (2026-07-28)",
    expectedProtocolVersion: "2026-07-28",
    clientOptions: { versionNegotiation: { mode: "auto" } },
  },
];

// The two tests above only ever exercise the "not configured" error path,
// under each era separately — neither proves a real successful call round-
// trips correctly, and neither covers anything from the live-audit
// checklist's other categories (input validation boundaries, cross-field
// pairing rules, not-found-in-a-batch) at all. This runs one representative
// call per category — not per tool, that's what the unit suite is for —
// against a real spawned process, once per supported protocol era, so an
// era-specific regression (e.g. the modern wire codec silently dropping a
// field, or a validation rule that only fires under one era's dispatch path)
// can't hide behind "we only ever checked the other one." Network-free via
// the local mock TMDB above.
describe("e2e: cross-era checklist", () => {
  for (const era of ERAS) {
    test(era.label, async (t) => {
      if (!existsSync(distPath)) {
        t.skip("dist/index.js not built — run `npm run build` first (CI builds before tests)");
        return;
      }

      const { server: mockTmdb, baseUrl } = await startMockTmdb();
      const env: Record<string, string> = { TMDB_API_TOKEN: "test-token", TMDB_BASE_URL: baseUrl };
      for (const [k, v] of Object.entries(process.env))
        if (
          v !== undefined &&
          k !== "TMDB_API_TOKEN" &&
          k !== "OMDB_API_KEY" &&
          k !== "TMDB_BASE_URL"
        )
          env[k] = v;

      const client = new Client({ name: `e2e-${era.label}`, version: "0" }, era.clientOptions);
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [distPath],
        env,
      });

      try {
        await client.connect(transport);
        assert.equal(client.getNegotiatedProtocolVersion?.(), era.expectedProtocolVersion);

        // 1. Input validation boundary: an unrecognized param is a hard
        // schema rejection (every inputSchema is .strict() per AGENTS.md),
        // not a silent no-op. Purely local — no network either era.
        const badParam = await client.callTool({
          name: "search_movies",
          arguments: { query: "matrix", bogus_field: "x" },
        });
        assert.equal(badParam.isError, true);

        // 2. Cross-field pairing rule: certification requires
        // certification_country — also purely local validation.
        const pairing = await client.callTool({
          name: "discover_movies",
          arguments: { certification: "PG-13" },
        });
        assert.equal(pairing.isError, true);
        const pairingText = (pairing.content as { type: string; text: string }[])[0]?.text ?? "";
        assert.match(pairingText, /certification_country/);

        // 3. Not-found path inside a batch: a bad id never fails the whole
        // call, sitting alongside a real successful entry in the same order.
        const batch = await client.callTool({
          name: "get_movies",
          arguments: { ids: [603, 999] },
        });
        assert.notEqual(batch.isError, true);
        const batchResults = (batch.structuredContent as { results: Record<string, unknown>[] })
          .results;
        assert.equal(batchResults.length, 2);
        assert.equal(batchResults[0]?.found, true);
        assert.equal(batchResults[0]?.title, "The Matrix");
        assert.equal(batchResults[1]?.found, false);

        // 4. Real successful single-item call: the full detail shape
        // survives whichever era's result envelope wrapped it.
        // include_ratings: false skips OMDb, so no second mock is needed.
        const movie = await client.callTool({
          name: "get_movie",
          arguments: { id: 603, include_ratings: false },
        });
        assert.notEqual(movie.isError, true);
        const s = movie.structuredContent as {
          title: string;
          certification: string;
          year: number;
        };
        assert.equal(s.title, "The Matrix");
        assert.equal(s.certification, "R");
        assert.equal(s.year, 1999);

        // 5. cacheHints is 2026-07-28-only (SEP-2549) — assert both sides of
        // that era split explicitly (presence on modern, absence on legacy)
        // instead of only ever checking the era where it fires. The typed
        // ListToolsResult hides ttlMs/cacheScope (StripWireOnly), so a
        // passthrough schema is the only way to see the raw wire object.
        const passthrough = z.record(z.string(), z.unknown());
        const rawTools = await client.request({ method: "tools/list", params: {} }, passthrough);
        if (era.expectedProtocolVersion === "2026-07-28") {
          assert.equal(rawTools.ttlMs, 3_600_000);
          assert.equal(rawTools.cacheScope, "public");
        } else {
          assert.equal("ttlMs" in rawTools, false);
          assert.equal("cacheScope" in rawTools, false);
        }
      } finally {
        await client.close();
        await new Promise<void>((resolve) => mockTmdb.close(() => resolve()));
      }
    });
  }
});

// start()'s shutdown path (serveStdio's handle.close() on SIGINT/SIGTERM) has
// no MCP-protocol surface to exercise through a Client — it's process
// lifecycle, only observable by actually sending the signal to a real spawned
// process and watching it exit. Spawned directly with child_process (no MCP
// client/handshake needed — this only cares whether the process starts,
// logs to stderr, and exits cleanly).
function spawnServer(): {
  child: ReturnType<typeof spawn>;
  ready: Promise<void>;
  stderr: () => string;
} {
  // stdin must stay open ("pipe", never ended) rather than "ignore": "ignore"
  // connects it to /dev/null, which is immediately at EOF — serveStdio() then
  // reads that as the client having disconnected and shuts the process down
  // on its own within milliseconds, before this test ever gets to send a
  // signal. A real MCP host keeps the child's stdin open for the connection's
  // whole lifetime, so this only closes an artifact of the test's own spawn
  // config, not a real one.
  const child = spawn(process.execPath, [distPath], { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server never printed 'ready'")), 5000);
    child.stderr!.on("data", () => {
      if (stderr.includes("ready")) {
        clearTimeout(timeout);
        // A real MCP host never signals a server within microseconds of
        // spawning it (there's at least a protocol handshake first). Under
        // heavy CPU contention a signal sent that fast can occasionally hit
        // Node's default disposition before its handler is actually
        // scheduled, independent of the stdin fix above — reproduced with a
        // signal-only repro under artificial load. A short, realistic grace
        // period avoids that race without weakening what this test verifies.
        setTimeout(resolve, 100);
      }
    });
  });
  return { child, ready, stderr: () => stderr };
}

describe("e2e: process lifecycle (SIGINT/SIGTERM)", () => {
  test("shuts down cleanly on SIGTERM", async (t) => {
    if (!existsSync(distPath)) {
      t.skip("dist/index.js not built — run `npm run build` first (CI builds before tests)");
      return;
    }
    // Windows has no POSIX signals: subprocess.kill("SIGTERM") force-terminates the
    // child directly instead of delivering anything its `process.on("SIGTERM", ...)`
    // handler could catch, so this test would pass there without ever exercising
    // server.ts's shutdown()/handle.close() path — a false-positive pass, not real
    // coverage. Skip rather than claim graceful-shutdown coverage this platform can't give.
    if (process.platform === "win32") {
      t.skip("SIGTERM isn't delivered to a signal handler on Windows — see comment above");
      return;
    }
    const { child, ready, stderr } = spawnServer();
    await ready;
    child.kill("SIGTERM");
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
      child.on("exit", (code, signal) => resolve([code, signal])),
    );
    assert.equal(code, 0);
    assert.equal(signal, null); // exited via process.exit(0), not killed by the signal itself
    assert.match(stderr(), /shutting down/);
  });

  test("shuts down cleanly on SIGINT", async (t) => {
    if (!existsSync(distPath)) {
      t.skip("dist/index.js not built — run `npm run build` first (CI builds before tests)");
      return;
    }
    // Same Windows caveat as the SIGTERM test above: subprocess.kill() force-terminates
    // unconditionally there regardless of which signal name is passed, never reaching
    // server.ts's shutdown() path — skip rather than claim coverage this platform can't give.
    if (process.platform === "win32") {
      t.skip("SIGINT isn't delivered to a signal handler on Windows — see comment above");
      return;
    }
    const { child, ready, stderr } = spawnServer();
    await ready;
    child.kill("SIGINT");
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
      child.on("exit", (code, signal) => resolve([code, signal])),
    );
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.match(stderr(), /shutting down/);
  });
});
