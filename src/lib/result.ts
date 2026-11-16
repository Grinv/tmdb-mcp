// Helpers that build MCP tool results. Tool handlers return these objects;
// failures become { isError: true } results (never thrown) so the agent
// receives an actionable message instead of a protocol error.
import { ApiError, type ApiErrorCode } from "./errors.ts";
import type { Logger } from "./logger.ts";
import { META_PREFIX } from "../version.ts";

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

/**
 * A tool failure as an RFC 9457 problem details object. MCP has no HTTP
 * response, so RFC 9457's `status` (the status of *this* HTTP response) is
 * not used; the upstream's status is the `upstream_status` extension, and
 * `retryable` tells the caller whether trying again can help. The model reads
 * `detail` as the result text; the whole object rides in `_meta`, never in
 * `structuredContent`, which MCP reserves for data matching the tool's
 * outputSchema.
 */
export interface Problem {
  type: string;
  title: string;
  detail: string;
  retryable: boolean;
  upstream_status?: number;
}

/** `_meta` key for the Problem on an error result, under this server's prefix. */
export const PROBLEM_META_KEY = `${META_PREFIX}problem`;

// Each problem type's URI points at its section in docs/errors.md.
const TYPE_BASE = "https://github.com/Grinv/tmdb-mcp/blob/main/docs/errors.md#";

type ProblemCode = ApiErrorCode | "internal" | "not_configured" | "invalid_arguments";

// One entry per problem type — a Record, so the compiler rejects a code
// without one. `title` is fixed per type (as RFC 9457 requires); toProblem
// alone composes each occurrence's `detail` from typed fields, never from an
// error's free-text message. No `advice` says "retry": that is derived from
// the occurrence's `retryable`, so the text and the flag can't disagree (an
// OMDb quota refusal is rate_limited yet not retryable).
const PROBLEMS: Record<ProblemCode, { title: string; advice?: string }> = {
  unauthorized: {
    title: "The upstream service rejected the credentials",
    advice: "They may be missing, invalid or expired — check the configured API key / token.",
  },
  forbidden: {
    title: "The upstream service denied access",
    advice: "The credentials may lack permission.",
  },
  not_found: { title: "No matching resource was found" },
  rate_limited: { title: "The upstream service is rate-limiting requests" },
  server_error: { title: "The upstream service returned an error" },
  network: {
    title: "Could not reach the upstream service (network error)",
    advice: "Check connectivity.",
  },
  timeout: { title: "The upstream request timed out" },
  cancelled: { title: "The request was cancelled" },
  bad_request: { title: "The request was rejected as invalid" },
  bad_response: { title: "The upstream service returned an unreadable response" },
  unknown: { title: "Unexpected error talking to the upstream service" },
  internal: {
    title: "Internal error in tmdb-mcp",
    advice: "Details are in the server log (stderr); please report it.",
  },
  not_configured: { title: "The upstream service is not configured" },
  invalid_arguments: { title: "Invalid arguments" },
};

const RETRY = "Please retry later.";

/** Every problem type; each `type` URI's section must exist in docs/errors.md. */
export const PROBLEM_CODES = Object.keys(PROBLEMS) as ProblemCode[];

/**
 * The one place a failure becomes tool-facing text. An ApiError is described
 * by its code, status and the upstream's own reason (`detail`) — never by its
 * `message`, which is diagnostics and may hold a raw response body. Anything
 * else is a bug in this server: it is logged in full (stack and cause chain)
 * and the caller gets a stable "internal error" instead of its internals.
 */
export function toProblem(err: unknown, logger: Logger): Problem {
  if (err instanceof ApiError) {
    const { title, advice } = PROBLEMS[err.code];
    const status = err.status ? ` (${err.status})` : "";
    // One status can mean several things (OMDb reports both a bad key and an
    // exhausted quota as refusals), so the upstream's own reason always shows.
    const reason = err.detail ? `The upstream said: "${err.detail}"` : undefined;
    return {
      type: TYPE_BASE + err.code,
      title,
      detail: [`${title}${status}.`, advice, err.retryable ? RETRY : undefined, reason]
        .filter(Boolean)
        .join(" "),
      retryable: err.retryable,
      ...(err.status ? { upstream_status: err.status } : {}),
    };
  }
  // Reported as a tool error, not a JSON-RPC one: it originates while the
  // tool runs, so the model must see the call failed (MCP's isError rule) —
  // the reference SDK's reading too. See docs/errors.md#internal.
  logger.error("internal error in a tool call:", err);
  return ownProblem("internal");
}

/** A problem this server raises itself (no thrown error): its own `detail`,
 *  or the type's title and advice. */
export function ownProblem(
  code: "internal" | "not_configured" | "invalid_arguments" | "cancelled",
  detail?: string,
): Problem {
  const { title, advice } = PROBLEMS[code];
  return {
    type: TYPE_BASE + code,
    title,
    detail: detail ?? [`${title}.`, advice].filter(Boolean).join(" "),
    retryable: false,
  };
}

/** An isError tool result: the model reads `detail`; the Problem is `_meta`. */
export function problemResult(problem: Problem): ToolResult {
  return {
    content: [{ type: "text", text: problem.detail }],
    isError: true,
    _meta: { [PROBLEM_META_KEY]: problem },
  };
}
