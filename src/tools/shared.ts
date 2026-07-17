// Small pieces shared by every tool-registration module: the read-only
// annotation, and the "does this client have credentials" short-circuit that
// every TMDB/OMDb tool needs before it can call its client.
import { errorResult, jsonResult, type ToolResult } from "../lib/result.js";
import { guard } from "./guard.js";

export const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

/** A client that can report whether it has credentials, and what to tell the
 *  caller when it doesn't — the pairing lives on the client so a tool file
 *  can't accidentally match one client's `configured` flag with another's
 *  message. */
export interface ConfigurableClient {
  configured: boolean;
  notConfiguredMessage: string;
}

/** Short-circuits with `client.notConfiguredMessage` when `client.configured`
 *  is false; otherwise runs `fn`, wraps its result via jsonResult, and guards
 *  against thrown ApiErrors — the common shape of every tool handler here. */
export function requireConfigured(
  client: ConfigurableClient,
  fn: () => Promise<Record<string, unknown>>,
): Promise<ToolResult> {
  if (!client.configured) return Promise.resolve(errorResult(client.notConfiguredMessage));
  return guard(async () => jsonResult(await fn()));
}
