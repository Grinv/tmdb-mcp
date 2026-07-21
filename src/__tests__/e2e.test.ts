import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, copyFileSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";

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
