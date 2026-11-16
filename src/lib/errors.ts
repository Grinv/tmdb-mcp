// Typed errors for upstream API failures. Clients throw `ApiError`; tool
// handlers turn it into an MCP tool result (lib/result.ts). Every known
// failure has its own code. Tool-facing text is built from code/status/detail
// only; `message` is for logs and may hold a raw response body.

export type ApiErrorCode =
  | "unauthorized" // 401, token missing/expired/invalid
  | "forbidden" // 403, insufficient permissions/scope
  | "not_found" // 404, no such resource
  | "rate_limited" // 429
  | "server_error" // 5xx
  | "network" // connection failed
  | "timeout" // request aborted by our timeout
  | "cancelled" // request aborted by the caller (e.g. MCP notifications/cancelled)
  | "bad_request" // 400/405/422, malformed or unsupported request
  | "bad_response" // a success status with a body we can't read (invalid JSON, empty)
  | "unknown"; // any other upstream status or refusal

export interface ApiErrorOptions {
  code: ApiErrorCode;
  message: string;
  /** The upstream's own (redacted) reason, e.g. "Invalid API key!", for the tool-facing text. */
  detail?: string;
  status?: number;
  /** Override TRANSIENT[code] for one occurrence whose nature differs from its
   *  code's (e.g. OMDb's daily quota: rate_limited, yet not transient). */
  retryable?: boolean;
  /** Retry-After hint, in ms, for the retry backoff. */
  retryAfterMs?: number;
  /** The underlying error this one wraps (a fetch or JSON.parse failure). */
  cause?: unknown;
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly detail: string | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(opts: ApiErrorOptions) {
    super(opts.message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "ApiError";
    this.code = opts.code;
    this.detail = opts.detail;
    this.status = opts.status;
    this.retryable = opts.retryable ?? TRANSIENT[opts.code];
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/**
 * Whether a failure of this kind is transient. This is the only place that
 * decides it: HttpClient retries transient failures, and the tool's problem
 * tells the caller a later retry can help. A Record, so the compiler rejects a
 * code without an entry.
 */
const TRANSIENT: Record<ApiErrorCode, boolean> = {
  unauthorized: false,
  forbidden: false,
  not_found: false,
  rate_limited: true,
  server_error: true,
  network: true,
  timeout: true,
  cancelled: false, // the caller's own decision
  bad_request: false,
  // A complete body that isn't JSON (a proxy's HTML page) won't change on
  // retry. A truncated body never gets here: undici rejects the read itself.
  bad_response: false,
  unknown: false,
};

/** Map an HTTP status code to an ApiErrorCode. */
export function classifyStatus(status: number): ApiErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 405 || status === 422) return "bad_request";
  if (status >= 500) return "server_error";
  return "unknown";
}

/** Strip anything that looks like a credential before logging. */
export function redact(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer ***")
    .replace(
      /\b(access_token|refresh_token|client_secret|client_id|apikey)=([^&\s"]+)/gi,
      "$1=***",
    );
}

/**
 * For optional data a caller can do without: resolves to undefined when the
 * upstream fails (any ApiError). Anything else is a bug and propagates.
 */
export async function unlessUpstreamFails<T>(promise: Promise<T>): Promise<T | undefined> {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof ApiError) return undefined;
    throw err;
  }
}
