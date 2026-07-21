// Shared test helpers. Not a test file (no *.test suffix) so the runner skips it.
import type { TestContext } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import assert from "node:assert/strict";
import { createLogger, type Logger } from "../lib/logger.js";
import { buildServer } from "../server.js";
import { loadConfig } from "../config.js";

export function silentLogger(): Logger {
  return createLogger("silent");
}

// Credentials + zeroed throttling so full-stack tests run offline and fast;
// shared so both TMDB and OMDb test files don't each redefine the same object.
export const DEFAULT_ENV: NodeJS.ProcessEnv = {
  TMDB_API_TOKEN: "test-token",
  OMDB_API_KEY: "test-key",
  TMDB_MIN_INTERVAL_MS: "0",
  OMDB_MIN_INTERVAL_MS: "0",
};

/** The text of a single MCP content block, asserting it's actually a text block. */
export function contentText(content: { type: string; text?: string } | undefined): string {
  assert.equal(content?.type, "text");
  return content!.text ?? "";
}

/** The first text content block's text from a tool call result (empty string if absent). */
export function toolText(res: { content?: unknown; [key: string]: unknown }): string {
  return contentText((res.content as { type: string; text?: string }[] | undefined)?.[0]);
}

/** Wrap results in TMDB's paged-response envelope (mirrors format.ts's `page()`). */
export function pageOf<T>(results: T[]): {
  results: T[];
  page: number;
  total_pages: number;
  total_results: number;
} {
  return { results, page: 1, total_pages: 1, total_results: results.length };
}

export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

type FetchArgs = Parameters<typeof fetch>;

export interface FetchMock {
  fn: typeof fetch;
  calls: { url: string; init: FetchArgs[1] }[];
}

/** Build a fetch mock from a handler, recording every call. */
export function mockFetch(
  handler: (url: string, init: FetchArgs[1]) => Response | Promise<Response>,
): FetchMock {
  const calls: FetchMock["calls"] = [];
  const fn = (async (input: FetchArgs[0], init?: FetchArgs[1]) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as { url: string }).url;
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

/** Install a fetch mock for the duration of a test; auto-restored via `t.mock`. */
export function installFetch(t: TestContext, mock: FetchMock): void {
  t.mock.method(globalThis, "fetch", mock.fn);
}

/** A fetch mock that never resolves on its own — only settles when its
 *  AbortSignal fires — so a test can abort mid-flight and observe the
 *  caller-cancellation path specifically, distinct from a timeout. Mirrors
 *  real fetch(): rejects immediately if the signal is already aborted by the
 *  time fetch() is called, not just on a future 'abort' event.
 *  `onStart` (if given) fires on every invocation, before the aborted-check —
 *  useful to synchronize a test's abort() call with the request genuinely
 *  being in flight. `onAbort` (if given) fires exactly when the mock rejects,
 *  for tests that want to assert the abort was actually observed server-side. */
export function hangingFetch(opts: { onStart?: () => void; onAbort?: () => void } = {}): FetchMock {
  return mockFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        opts.onStart?.();
        if (init?.signal?.aborted) {
          opts.onAbort?.();
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        init?.signal?.addEventListener("abort", () => {
          opts.onAbort?.();
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
  );
}

/** Build the server and connect an in-memory client for end-to-end tool tests. */
export async function connectServer(
  env: NodeJS.ProcessEnv = {},
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = buildServer(loadConfig(env), silentLogger());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  // Prime the client's tools/list cache: callTool() only validates a result's
  // structuredContent against the tool's outputSchema when this cache is
  // already populated, so every callTool() in the suite doubles as an
  // outputSchema conformance check instead of silently skipping validation.
  await client.listTools();
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
