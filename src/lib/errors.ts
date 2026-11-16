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
  /** Override KIND[code].transient for one occurrence whose nature differs from its
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
    this.retryable = opts.retryable ?? KIND[opts.code].transient;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/**
 * Two separate properties of each kind of failure, decided only here (a
 * Record, so the compiler rejects a code without an entry):
 * - `transient`: retrying soon can help. HttpClient retries these, and the
 *   tool's problem tells the caller so. One occurrence may override it via
 *   `retryable` (OMDb's daily quota).
 * - `outage`: the upstream couldn't answer, as opposed to answering
 *   authoritatively (a 404, a rejected key, a bad request). Only then may a
 *   cached copy or a partial result stand in (RFC 5861's stale-if-error).
 *   Never overridden, so OMDb's quota stays an outage though not retryable.
 */
const KIND: Record<ApiErrorCode, { transient: boolean; outage: boolean }> = {
  unauthorized: { transient: false, outage: false },
  forbidden: { transient: false, outage: false },
  not_found: { transient: false, outage: false },
  rate_limited: { transient: true, outage: true },
  server_error: { transient: true, outage: true },
  network: { transient: true, outage: true },
  timeout: { transient: true, outage: true },
  cancelled: { transient: false, outage: false }, // the caller's own decision
  bad_request: { transient: false, outage: false },
  // A complete body that isn't the API's JSON (a proxy's or captive portal's
  // page) won't change on retry, but the upstream wasn't reached, like a 502.
  // A truncated body never gets here: undici rejects the read itself.
  bad_response: { transient: false, outage: true },
  // An unclassified status or refusal: unknown, so it isn't hidden.
  unknown: { transient: false, outage: false },
};

export function isOutage(err: unknown): boolean {
  return err instanceof ApiError && KIND[err.code].outage;
}

/** Map an HTTP status code to an ApiErrorCode. */
export function classifyStatus(status: number): ApiErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 408) return "timeout"; // a proxy or gateway gave up waiting
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
 * For optional data a caller can do without: resolves to undefined during an
 * upstream outage (isOutage). Anything else (an authoritative failure, a bug)
 * propagates.
 */
export async function unlessOutage<T>(promise: Promise<T>): Promise<T | undefined> {
  try {
    return await promise;
  } catch (err) {
    if (isOutage(err)) return undefined;
    throw err;
  }
}
