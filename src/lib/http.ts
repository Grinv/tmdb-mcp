// Thin fetch wrapper shared by both API clients: timeouts, bounded retries
// with exponential backoff (honoring Retry-After), a default User-Agent, and
// uniform mapping of failures to ApiError.
import { setTimeout as sleep } from "node:timers/promises";
import { ApiError, classifyStatus, isOutage, redact } from "./errors.ts";
import type { Logger } from "./logger.ts";
import { USER_AGENT } from "../version.ts";

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  /** Caller-supplied cancellation (e.g. an MCP tool call's abort signal). */
  signal?: AbortSignal;
}

export interface HttpClientOptions {
  baseUrl: string;
  logger: Logger;
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
  /** Max retry attempts for transient failures (see errors.ts's KIND). */
  retries?: number;
  /** Called before each request; lets callers throttle (rate limiting). */
  beforeRequest?: () => Promise<void> | void;
  /** JSON.parse reviver for success bodies: the upstream's own normalization rule. */
  reviver?: (this: unknown, key: string, value: unknown) => unknown;
  /** The upstream's reason when a success body is really a refusal (OMDb
   *  answers 200 with `Response: "False"`); it then fails like an error
   *  status, through refineError, the retry decision and the outage log. */
  refusedBody?: (body: object) => string | undefined;
  /** The upstream's own classification rule (e.g. OMDb naming its daily quota
   *  in the body), applied to every failure before the retry decision. */
  refineError?: (err: ApiError) => ApiError;
}

/**
 * A reviver for upstreams whose `null` only ever means "no value" (TMDB,
 * OMDb): it drops the property, so a field typed `field?: T` is a T or absent
 * and `=== undefined` / `??` / `if (!x)` agree. Not for APIs where null carries
 * meaning (e.g. GraphQL's `data.Media: null` = not found). Nulls inside arrays
 * are kept so arrays get no holes.
 */
export function nullAsAbsent(this: unknown, _key: string, value: unknown): unknown {
  return value === null && !Array.isArray(this) ? undefined : value;
}

const MAX_BACKOFF_MS = 8000;

export class HttpClient {
  readonly #opts: HttpClientOptions;

  constructor(opts: HttpClientOptions) {
    this.#opts = opts;
  }

  /** GET a JSON resource. This server is read-only, so GET is the only verb. */
  async getJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.#buildUrl(path, options.query);
    try {
      return await this.#withRetries<T>(url, options);
    } catch (err) {
      // Every request's failure leaves here once, cached or not, so this is
      // where an outage is logged (a 404 is an answer, not one). Without the
      // query: it holds what the user searched for.
      const { origin, pathname } = new URL(url);
      if (isOutage(err)) this.#opts.logger.warn(`GET ${origin}${pathname} failed`, err);
      throw err;
    }
  }

  async #withRetries<T>(url: string, options: RequestOptions): Promise<T> {
    const retries = this.#opts.retries ?? 2;
    const timeoutMs = this.#opts.timeoutMs ?? 15000;

    let attempt = 0;
    for (;;) {
      if (this.#opts.beforeRequest) await this.#opts.beforeRequest();
      try {
        return await this.#once<T>(url, options, timeoutMs);
      } catch (err) {
        const classified = err instanceof ApiError ? err : toNetworkError(err);
        const apiErr = this.#opts.refineError?.(classified) ?? classified;
        // Never retry a caller-cancelled request, even if its code is retryable
        // (e.g. it raced a timeout).
        if (!apiErr.retryable || attempt >= retries || options.signal?.aborted) throw apiErr;
        const backoff = backoffMs(attempt, apiErr);
        this.#opts.logger.debug(
          `retrying ${url} after ${backoff}ms (attempt ${attempt + 1}/${retries}, ${apiErr.code})`,
        );
        // Node's promisified timer, so a caller's cancel interrupts the wait
        // instead of sitting out up to MAX_BACKOFF_MS.
        try {
          await sleep(backoff, undefined, { signal: options.signal });
        } catch (abort) {
          throw new ApiError({
            code: "cancelled",
            message: "Request aborted by caller",
            cause: abort,
          });
        }
        attempt += 1;
      }
    }
  }

  async #once<T>(url: string, options: RequestOptions, timeoutMs: number): Promise<T> {
    // Not AbortSignal.timeout(): its timer is unref'd, so with a mocked fetch
    // (no socket keeping the loop alive) the process can exit before it fires.
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    // AbortSignal.any() (Node >=20.3) merges the caller's cancellation and our
    // timeout into the one signal fetch() takes, including an already-aborted
    // caller signal (cancelled while awaiting the rate limiter). The inputs
    // keep their own .aborted, so the catch below can tell cancel from timeout.
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutController.signal])
      : timeoutController.signal;

    // The timer stays armed until the body is read, not just the headers: an
    // upstream that stalls mid-body would otherwise hang res.text() (and every
    // cache waiter on the key).
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
          ...this.#opts.defaultHeaders,
        },
        signal,
      });
      if (!res.ok) throw await toHttpError(res);
      const text = await res.text();
      // Both upstreams send JSON on success, so an empty body (a 204 or an
      // empty 200) is as unreadable as invalid JSON. A body cut off mid-read
      // rejects res.text() instead, which is a transient network error.
      if (text.length === 0) {
        throw new ApiError({ code: "bad_response", message: "Upstream returned an empty body" });
      }
      let body: unknown;
      try {
        body = JSON.parse(text, this.#opts.reviver);
      } catch (err) {
        throw new ApiError({
          code: "bad_response",
          message: "Upstream returned invalid JSON",
          cause: err,
        });
      }
      // Both upstreams answer with a JSON object or array; a bare `null` (which
      // the reviver turns into undefined) or a scalar is as unreadable.
      if (body === null || typeof body !== "object") {
        throw new ApiError({
          code: "bad_response",
          message: "Upstream returned a non-object JSON body",
        });
      }
      const reason = this.#opts.refusedBody?.(body);
      if (reason !== undefined) {
        throw new ApiError({
          code: "unknown",
          status: res.status,
          message: `Upstream refused the request: ${redact(reason)}`,
          detail: redact(reason),
        });
      }
      return body as T;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (options.signal?.aborted) {
        // Caller cancelled (e.g. the MCP client sent notifications/cancelled);
        // not retryable, and distinct from our own timeout.
        throw new ApiError({ code: "cancelled", message: "Request aborted by caller", cause: err });
      }
      if (timeoutController.signal.aborted) {
        throw new ApiError({
          code: "timeout",
          message: `Request timed out after ${timeoutMs}ms`,
          cause: err,
        });
      }
      throw toNetworkError(err);
    } finally {
      clearTimeout(timer);
    }
  }

  #buildUrl(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(path.replace(/^\//, ""), ensureTrailingSlash(this.#opts.baseUrl));
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }
}

async function toHttpError(res: Response): Promise<ApiError> {
  const code = classifyStatus(res.status);
  let raw = "";
  try {
    raw = await res.text();
  } catch {
    /* ignore body read errors */
  }
  // Prefer a structured `message`/`error` field; fall back to the raw body.
  // Redacted here, not only in the logger: the reason becomes the `detail` the
  // model sees (toProblem), and some upstreams echo the request URL, apikey
  // included, in an error body.
  const reason = parseErrorMessage(raw);
  const detail = redact(reason ?? raw.slice(0, 500));
  const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
  return new ApiError({
    code,
    status: res.status,
    message: `HTTP ${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`,
    // Only a structured reason reaches the tool-facing text; a raw body is wire noise.
    ...(reason ? { detail } : {}),
    retryAfterMs: retryAfter,
  });
}

// JSON APIs return an error envelope with the reason in a named field.
function parseErrorMessage(raw: string): string | undefined {
  if (!raw) return undefined;
  try {
    const obj: unknown = JSON.parse(raw);
    if (obj === null || typeof obj !== "object") return undefined;
    const rec = obj as Record<string, unknown>;
    // TMDB puts its reason in `status_message`, OMDb in `Error`. Capped like
    // the raw-body fallback in toHttpError, so a verbose reason can't make the
    // tool-facing text unbounded.
    for (const field of ["message", "error", "status_message", "Error"]) {
      if (typeof rec[field] === "string") return rec[field].slice(0, 500);
    }
    return undefined;
  } catch {
    return undefined; // not JSON — caller falls back to the raw body
  }
}

function toNetworkError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  return new ApiError({
    code: "network",
    message: err instanceof Error ? `Network error: ${redact(err.message)}` : "Network error",
    cause: err,
  });
}

function backoffMs(attempt: number, err: ApiError): number {
  const hinted = err.retryAfterMs;
  if (typeof hinted === "number" && hinted > 0) return Math.min(hinted, MAX_BACKOFF_MS);
  return Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt);
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function ensureTrailingSlash(s: string): string {
  return s.endsWith("/") ? s : s + "/";
}
