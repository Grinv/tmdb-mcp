// Small pieces shared by every tool-registration module: the read-only
// annotation, and the "does this client have credentials" short-circuit that
// every TMDB/OMDb tool needs before it can call its client.
import { ApiError } from "../lib/errors.js";
import { apiErrorToResult, errorResult, jsonResult, type ToolResult } from "../lib/result.js";

export const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

// Vendor-prefixed per this server's tmdb-mcp identity (see package.json's
// mcpName) so the key can't collide with another server's `_meta` or a
// future MCP-reserved one (reserved prefixes require a "modelcontextprotocol"
// or "mcp" second label — see the MCP spec's `_meta` key-naming rules).
const STALE_META_KEY = "tmdb-mcp/stale";

/** Tracks whether a stale-cache fallback fired anywhere during a tool call,
 *  so a handler can surface it as `_meta` without threading a flag through
 *  every client method's return value. Pass `.onStale` into any client
 *  method that accepts one; pass `.meta` as requireConfigured's `getMeta`. */
export function trackStale(): {
  onStale: () => void;
  meta: () => Record<string, unknown> | undefined;
} {
  let stale = false;
  return {
    onStale: () => {
      stale = true;
    },
    meta: () => (stale ? { [STALE_META_KEY]: true } : undefined),
  };
}

/** A client that can report whether it has credentials, and what to tell the
 *  caller when it doesn't — the pairing lives on the client so a tool file
 *  can't accidentally match one client's `configured` flag with another's
 *  message. */
export interface ConfigurableClient {
  configured: boolean;
  notConfiguredMessage: string;
}

/** Short-circuits with `client.notConfiguredMessage` when `client.configured`
 *  is false; otherwise, if `validate` returns a message, short-circuits with
 *  that (checked in this order — after configured, before calling `fn` — so a
 *  handler needing both checks doesn't have to repeat the configured check
 *  itself just to get the ordering right); otherwise runs `fn`, wraps its
 *  result via jsonResult, and converts any thrown error into a tool result
 *  instead of letting it propagate — the common shape of every tool handler
 *  here. `getMeta`, if given, is called after `fn` resolves successfully and
 *  its return value (if any) becomes the result's `_meta` — used to surface
 *  side signals (e.g. "this data is from a stale cache") that a handler
 *  collected while `fn` ran, without threading them through `fn`'s own return
 *  value. */
export async function requireConfigured(
  client: ConfigurableClient,
  fn: () => Promise<Record<string, unknown>>,
  validate?: () => string | undefined,
  getMeta?: () => Record<string, unknown> | undefined,
): Promise<ToolResult> {
  if (!client.configured) return errorResult(client.notConfiguredMessage);
  const validationError = validate?.();
  if (validationError) return errorResult(validationError);
  try {
    const data = await fn();
    return jsonResult(data, getMeta?.());
  } catch (err) {
    if (err instanceof ApiError) return apiErrorToResult(err);
    return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
