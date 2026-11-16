// Small pieces shared by every tool-registration module: the read-only
// annotation, and the "does this client have credentials" short-circuit that
// every TMDB/OMDb tool needs before it can call its client.
import { ApiError } from "../lib/errors.ts";
import {
  jsonResult,
  ownProblem,
  problemResult,
  toProblem,
  type ToolResult,
} from "../lib/result.ts";
import type { Logger } from "../lib/logger.ts";
import { META_PREFIX } from "../version.ts";
import { callNotes, type CallNotes } from "../lib/cache.ts";

export const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

// Under this server's reverse-DNS _meta prefix (version.ts), so it can't
// collide with another server's or an MCP-reserved key.
export const STALE_META_KEY = `${META_PREFIX}stale`;
// Set when part of the result is missing because an upstream part failed
// (e.g. a season's episodes, or native-language trailers).
export const PARTIAL_META_KEY = `${META_PREFIX}partial`;

/** A client that can report whether it has credentials, and what to tell the
 *  caller when it doesn't — the pairing lives on the client so a tool file
 *  can't accidentally match one client's `configured` flag with another's
 *  message. */
export interface ConfigurableClient {
  configured: boolean;
  notConfiguredMessage: string;
  /** Where an internal error during this client's tool calls is logged. */
  logger: Logger;
}

/** Short-circuits with `client.notConfiguredMessage` when `client.configured`
 *  is false; otherwise, if `validate` returns a message, short-circuits with
 *  that (checked in this order — after configured, before calling `fn` — so a
 *  handler needing both checks doesn't have to repeat the configured check
 *  itself just to get the ordering right); otherwise runs `fn`, wraps its
 *  result via jsonResult, and converts any thrown error into a tool result
 *  instead of letting it propagate — the common shape of every tool handler
 *  here. `fn` runs inside a fresh CallNotes record (lib/cache.ts): if the
 *  data below it was stale or partial, the result's `_meta` says so, with
 *  nothing for the handler or client to wire. */
export async function requireConfigured(
  client: ConfigurableClient,
  fn: () => Promise<Record<string, unknown>>,
  validate?: () => string | undefined,
  signal?: AbortSignal,
): Promise<ToolResult> {
  if (!client.configured) {
    return problemResult(ownProblem("not_configured", client.notConfiguredMessage));
  }
  const validationError = validate?.();
  if (validationError) return problemResult(ownProblem("invalid_arguments", validationError));
  const notes: CallNotes = {};
  try {
    const data = await callNotes.run(notes, () => raceAbort(fn(), signal));
    const meta = {
      ...(notes.staleAgeMs === undefined
        ? {}
        : { [STALE_META_KEY]: { age_seconds: Math.round(notes.staleAgeMs / 1000) } }),
      ...(notes.partial ? { [PARTIAL_META_KEY]: true } : {}),
    };
    return jsonResult(data, Object.keys(meta).length ? meta : undefined);
  } catch (err) {
    return problemResult(toProblem(err, client.logger));
  }
}

/** Resolves/rejects as soon as either `promise` settles or `signal` aborts, so
 *  a cancelled MCP tool call stops waiting promptly instead of hanging until
 *  a cache-shared upstream fetch (which may still be serving other concurrent
 *  callers) finishes. Deliberately does NOT abort the underlying fetch itself:
 *  TtlCache dedupes concurrent callers for the same key onto one shared
 *  in-flight request (see lib/cache.ts's #dedupe), so cancelling it here would
 *  also cancel it for every other caller currently waiting on that same key. */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  // The same classified failure the transport raises for a cancelled fetch,
  // so toProblem reports both one way.
  const cancelled = () =>
    new ApiError({ code: "cancelled", message: "Request cancelled by the caller" });
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelled());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}
