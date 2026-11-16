// Helpers that build MCP tool results. Tool handlers return these objects;
// failures become { isError: true } results (never thrown) so the agent
// receives an actionable message instead of a protocol error.
import type { ApiError, ApiErrorCode } from "./errors.ts";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  // Matches the SDK's CallToolResult index signature.
  [key: string]: unknown;
}

/** Success result carrying both a text mirror and structured data.
 *
 * The text is compact (no indentation): MCP clients that don't read
 * `structuredContent` fall back to this string and feed it to the model, so
 * pretty-print whitespace would be pure token overhead.
 *
 * `meta`, when given, is attached as the result's `_meta` — a sibling of
 * `structuredContent`, never merged into it, so it stays out of the tool's
 * `outputSchema`-validated payload (e.g. a stale-cache flag is metadata about
 * the response, not part of the movie/show shape itself). */
export function jsonResult(
  structured: Record<string, unknown>,
  meta?: Record<string, unknown>,
): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
    ...(meta ? { _meta: meta } : {}),
  };
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Translate an upstream ApiError into a friendly, actionable tool error. */
export function apiErrorToResult(err: ApiError): ToolResult {
  return errorResult(messageFor(err));
}

/** The same friendly text as apiErrorToResult, for a caller that needs the
 * string rather than a whole ToolResult — e.g. get_movies/get_tv_shows, where
 * a single failed id becomes that entry's `reason` inside an otherwise
 * successful batch result rather than failing the call. Without this, such a
 * caller falls back to the raw `Error.message` (`HTTP 404 : {"success":false,
 * ...}`), which is the upstream's wire payload, not an actionable message. */
export function apiErrorMessage(err: ApiError): string {
  return messageFor(err);
}

// One entry per code — a Record, so the compiler rejects a code without one —
// and one composition rule in messageFor, so the status, the upstream's
// reason and the advice can't be forgotten or repeated branch by branch.
const MESSAGES: Record<ApiErrorCode, { what: string; advice?: string; ownMessage?: true }> = {
  unauthorized: {
    what: "The upstream service rejected the credentials",
    advice: "They may be missing, invalid or expired — check the configured API key / token.",
  },
  forbidden: {
    what: "The upstream service denied access",
    advice: "The credentials may lack permission.",
  },
  not_found: { what: "No matching resource was found" },
  rate_limited: {
    what: "The upstream service is rate-limiting requests",
    advice: "Please retry later.",
  },
  server_error: { what: "The upstream service returned an error", advice: "Please retry later." },
  network: {
    what: "Could not reach the upstream service (network error)",
    advice: "Check connectivity and retry.",
  },
  timeout: { what: "The upstream request timed out", advice: "Please retry." },
  // No fixed text explains these, so our own message does — unless the
  // upstream's reason is there, which it would only repeat.
  bad_request: { what: "The request was rejected as invalid", ownMessage: true },
  unknown: { what: "Unexpected error talking to the upstream service", ownMessage: true },
};

function messageFor(err: ApiError): string {
  const { what, advice, ownMessage } = MESSAGES[err.code];
  // The status is shown only when there was one: OMDb also reports failures
  // in a 200 body (see clients/omdb.ts), so the code alone can't name it.
  const status = err.status ? ` (${err.status})` : "";
  const own = ownMessage && !err.detail ? `: ${err.message}` : "";
  // Never drop the upstream's own reason: one status can mean several things
  // (OMDb reports both a bad key and an exhausted quota as refusals).
  const reason = err.detail ? `The upstream said: "${err.detail}"` : undefined;
  return [`${what}${status}${own}.`, advice, reason].filter(Boolean).join(" ");
}
