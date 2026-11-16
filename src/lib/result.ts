// Helpers that build MCP tool results. Tool handlers return these objects;
// failures become { isError: true } results (never thrown) so the agent
// receives an actionable message instead of a protocol error.
import type { ApiError } from "./errors.ts";

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

function messageFor(err: ApiError): string {
  // The status is shown only when there was one: OMDb also reports failures
  // in a 200 body (see clients/omdb.ts), so the code alone can't name it.
  const status = err.status ? ` (${err.status})` : "";
  const base = baseMessage(err, status);
  // Never drop the upstream's own reason: one status can mean several things
  // (OMDb reports both a bad key and an exhausted quota as refusals).
  return err.detail ? `${base} The upstream said: "${err.detail}"` : base;
}

function baseMessage(err: ApiError, status: string): string {
  switch (err.code) {
    case "unauthorized":
      return (
        `The upstream service rejected the credentials${status}. They may be missing, invalid ` +
        "or expired — check the configured API key / token."
      );
    case "forbidden":
      return `The upstream service denied access${status}. The credentials may lack permission.`;
    case "not_found":
      return `No matching resource was found${status}.`;
    case "rate_limited":
      return `The upstream service is rate-limiting requests${status}. Please retry later.`;
    case "server_error":
      return `The upstream service returned an error${status}. Please retry later.`;
    case "network":
      return "Could not reach the upstream service (network error). Check connectivity and retry.";
    case "timeout":
      return "The upstream request timed out. Please retry.";
    // Without an upstream reason (detail), our own message is all there is;
    // with one, messageFor appends it and repeating err.message would say it twice.
    case "bad_request":
      return `The request was rejected as invalid${status}${err.detail ? "." : `: ${err.message}`}`;
    default:
      return `Unexpected error talking to the upstream service${err.detail ? "." : `: ${err.message}`}`;
  }
}
