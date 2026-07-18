// Shared test helpers. Not a test file (no *.test suffix) so the runner skips it.
import type { TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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

/** Build the server and connect an in-memory client for end-to-end tool tests. */
export async function connectServer(
  env: NodeJS.ProcessEnv = {},
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = buildServer(loadConfig(env), silentLogger());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
