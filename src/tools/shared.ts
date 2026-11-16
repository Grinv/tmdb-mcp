// Shared by every tool module: the read-only annotation and the
// "does this client have credentials" short-circuit.
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
// collide with another server's or a reserved MCP key.
export const STALE_META_KEY = `${META_PREFIX}stale`;
// Set when part of the result is missing because an upstream call failed
// (e.g. a season's episodes, or native-language trailers).
export const PARTIAL_META_KEY = `${META_PREFIX}partial`;

/** A client that reports whether it has credentials and what to tell the caller
 *  when it doesn't. Both live on the client so a tool can't pair one client's
 *  flag with another's message. */
export interface ConfigurableClient {
  configured: boolean;
  notConfiguredMessage: string;
  /** Where an internal error during this client's tool calls is logged. */
  logger: Logger;
}

/** The common shape of every tool handler. Returns `client.notConfiguredMessage`
 *  when the client has no credentials; then a `validate` message if it returns
 *  one (so a handler needing both checks gets them in that order); otherwise
 *  runs `fn`, wraps the result via jsonResult and turns a thrown error into a
 *  tool result. `fn` runs inside a fresh CallNotes record (lib/cache.ts), so
 *  stale or partial data below it shows up in the result's `_meta` without
 *  any wiring in the handler. */
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

/** Settles as soon as `promise` settles or `signal` aborts, so a cancelled tool
 *  call stops waiting instead of hanging on a shared upstream fetch. It does
 *  not abort that fetch: TtlCache dedupes concurrent callers for a key onto one
 *  in-flight request (lib/cache.ts's #dedupe), so aborting it would cancel it
 *  for every other caller waiting on the same key. */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  // Same failure the transport raises for a cancelled fetch, so toProblem
  // reports both alike.
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
