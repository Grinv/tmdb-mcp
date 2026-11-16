// Tiny in-memory TTL cache for read endpoints. Caching cuts latency and eases
// pressure on rate-limited upstreams. Expired entries are retained (bounded by
// max size) so they can be served as a stale fallback when the upstream is down
// — for at most `maxStaleMs` past expiry, like RFC 5861's stale-if-error.
//
// One instance is shared across a client's many endpoints, each storing its
// own shape under its own key (a movie detail, a credits list, a genre map,
// …) — genuinely heterogeneous storage, not one fixed type. So the type
// parameter lives on each method call, not on the class: callers get back
// whatever type their own `compute()`/`value` actually is, instead of every
// caller being forced down to one class-wide type (previously
// `Record<string, unknown>`, which every method had to individually re-widen
// to and callers had to cast back out of).

/**
 * Build a deterministic cache key from a stable resource path (e.g.
 * `movie:${id}`) plus the params that vary the *shaped* response (region,
 * language, ...). Named fields instead of hand-interpolated template literals
 * make each cached accessor's variance dimensions visible at the call site
 * and sort-order-independent, closing the bug class where a dimension (e.g.
 * region) was silently left out of a key and one request's response leaked
 * into another's cache slot.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Logger } from "./logger.ts";

export function cacheKey(
  resource: string,
  dims: Record<string, string | number | boolean | undefined> = {},
): string {
  const parts = Object.keys(dims)
    .sort()
    .map((k) => `${k}=${dims[k] ?? ""}`);
  return parts.length ? `${resource}:${parts.join(":")}` : resource;
}

interface Entry {
  value: unknown;
  storedAt: number;
}

/** What one tool call's cache reads reported: the age (ms since it was
 *  fetched) of the oldest stale value served, if any. */
export interface Staleness {
  ageMs?: number;
}

/**
 * Carries a Staleness record through one tool call's async work (tools/
 * shared.ts runs each call inside it), so a stale fallback anywhere below is
 * reported without every client method threading a callback — a method can't
 * forget to. The record is read in each caller's own catch, so with
 * deduplicated in-flight fetches only the callers actually served stale data
 * are flagged.
 */
export const staleness = new AsyncLocalStorage<Staleness>();

export class TtlCache {
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #logger?: Logger;
  readonly #map = new Map<string, Entry>();
  // In-flight compute() promises, keyed like #map. Without this, two callers
  // racing on the same cold/expired key (e.g. two tools reading the same
  // cached dictionary at once) would each fire their own upstream request;
  // the second now shares the first's promise instead.
  readonly #pending = new Map<string, Promise<unknown>>();

  readonly #now: () => number;
  readonly #maxStaleMs: number;

  constructor(opts: {
    ttlMs: number;
    max?: number;
    /** How long past expiry a value may still be served when the upstream
     *  fails (RFC 5861's stale-if-error window); unbounded by default. */
    maxStaleMs?: number;
    logger?: Logger;
    /** Monotonic clock (ms). Wall-clock time (Date.now) jumps with NTP or a
     *  resume from sleep, which would expire everything at once or nothing
     *  for hours; tests pass their own. */
    now?: () => number;
  }) {
    this.#ttlMs = opts.ttlMs;
    this.#max = opts.max ?? 500;
    this.#logger = opts.logger;
    this.#now = opts.now ?? (() => performance.now());
    this.#maxStaleMs = opts.maxStaleMs ?? Infinity;
  }

  /** Fresh (non-expired) value, or undefined. */
  get<T>(key: string): T | undefined {
    const hit = this.#touch(key);
    if (!hit) return undefined;
    return this.#now() < hit.storedAt + this.#ttlMs ? (hit.value as T) : undefined;
  }

  set<T>(key: string, value: T): void {
    if (this.#ttlMs <= 0) return;
    this.#map.delete(key);
    if (this.#map.size >= this.#max) {
      const oldest = this.#map.keys().next().value;
      if (oldest !== undefined) this.#map.delete(oldest);
    }
    this.#map.set(key, { value, storedAt: this.#now() });
  }

  // Map iterates in insertion order, so re-inserting a key on every hit keeps
  // the first key the least recently used one — the one set() evicts.
  #touch(key: string): Entry | undefined {
    const hit = this.#map.get(key);
    if (hit) {
      this.#map.delete(key);
      this.#map.set(key, hit);
    }
    return hit;
  }

  /**
   * Get-or-compute, caching the resolved value. If `compute` throws and a
   * cached value no older than the stale window exists, serve that instead of
   * failing, so reads degrade gracefully while the upstream is down — and
   * record its age in the current `staleness` record for the tool result.
   */
  async wrapStaleOnError<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const fresh = this.get<T>(key);
    if (fresh !== undefined) return fresh;
    try {
      return await this.#dedupe(key, compute);
    } catch (err) {
      const hit = this.#touch(key);
      const ageMs = hit && this.#now() - hit.storedAt;
      if (hit && ageMs !== undefined && ageMs <= this.#ttlMs + this.#maxStaleMs) {
        // The logger formats the error (stack, cause chain, redaction).
        this.#logger?.warn(
          `serving stale cached value for "${key}" — upstream refresh failed`,
          err,
        );
        const record = staleness.getStore();
        if (record) record.ageMs = Math.max(record.ageMs ?? 0, ageMs);
        return hit.value as T;
      }
      throw err;
    }
  }

  // Share one in-flight compute() promise across concurrent callers of the
  // same key, so a cold/expired key triggers exactly one upstream fetch no
  // matter how many callers race on it. The resolved value is cached exactly
  // once (by the shared promise's own .then, not per-caller); a rejection
  // propagates to every waiter and clears the slot so the next call retries.
  #dedupe<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const inFlight = this.#pending.get(key) as Promise<T> | undefined;
    if (inFlight) return inFlight;
    const promise = compute()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => this.#pending.delete(key));
    this.#pending.set(key, promise);
    return promise;
  }
}
