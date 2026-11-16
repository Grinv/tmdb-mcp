// Tiny in-memory TTL cache for read endpoints. Expired entries are kept
// (bounded by max size) as a stale fallback for when the upstream is down, for
// at most `maxStaleMs` past expiry (RFC 5861's stale-if-error).
//
// One instance serves all of a client's endpoints, each storing its own shape
// under its own key (movie detail, credits, genre map, ...). So the type
// parameter is on each method, not on the class: callers get back the type
// their own `compute()`/`value` has.

/**
 * Build a deterministic cache key from a stable resource path (e.g.
 * `movie:${id}`) plus the params that vary the *shaped* response (region,
 * language, ...). Named fields make those dimensions visible at the call site
 * and independent of order. A dimension left out of a key would leak one
 * request's response into another's cache slot.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { isOutage } from "./errors.ts";
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

/** What one tool call learned about its data, for the result's `_meta`: the
 *  age (ms since fetched) of the oldest stale value it used, and whether any
 *  part is incomplete. */
export interface CallNotes {
  staleAgeMs?: number;
  partial?: boolean;
}

/**
 * Carries a CallNotes record through one tool call's async work (tools/shared.ts
 * runs each call inside one), so the cache can report stale or partial data
 * without client methods passing anything along.
 */
export const callNotes = new AsyncLocalStorage<CallNotes>();

function note(n: CallNotes): void {
  const record = callNotes.getStore();
  if (!record) return;
  if (n.staleAgeMs !== undefined) {
    record.staleAgeMs = Math.max(record.staleAgeMs ?? 0, n.staleAgeMs);
  }
  if (n.partial) record.partial = true;
}

class Degraded<T> {
  readonly value: T;
  constructor(value: T) {
    this.value = value;
  }
}

/** Marks a compute() result as usable but incomplete (part of the upstream
 *  failed). It is never cached; a complete stale copy wins over it, otherwise
 *  the caller gets it noted as partial. */
export function degraded<T>(value: T): Degraded<T> {
  return new Degraded(value);
}

export class TtlCache {
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #maxStaleMs: number;
  readonly #logger?: Logger;
  readonly #now: () => number;
  readonly #map = new Map<string, Entry>();
  // In-flight computes, keyed like #map, so concurrent callers of a cold key
  // share one upstream fetch.
  readonly #pending = new Map<string, Promise<Computed<unknown>>>();

  constructor(opts: {
    ttlMs: number;
    max?: number;
    /** How long past expiry a value may stand in for an upstream outage
     *  (RFC 5861's stale-if-error window); unbounded by default. */
    maxStaleMs?: number;
    logger?: Logger;
    /** Clock (ms), injectable for tests. Wall clock by default: an entry's age
     *  must include time the machine slept, and a monotonic clock stops during
     *  suspend, which would keep yesterday's data "fresh" after wake-up. */
    now?: () => number;
  }) {
    this.#ttlMs = opts.ttlMs;
    this.#max = opts.max ?? 500;
    this.#maxStaleMs = opts.maxStaleMs ?? Infinity;
    this.#logger = opts.logger;
    this.#now = opts.now ?? (() => Date.now());
  }

  /** Fresh (non-expired) value, or undefined. */
  get<T>(key: string): T | undefined {
    const hit = this.#map.get(key);
    if (!hit) return undefined;
    // A negative age means the clock stepped back since the entry was stored;
    // its true age is unknown, so it isn't fresh.
    const ageMs = this.#now() - hit.storedAt;
    if (ageMs < 0 || ageMs >= this.#ttlMs) return undefined;
    this.#touch(key, hit);
    return hit.value as T;
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

  // Map iterates in insertion order, so re-inserting on every hit keeps the
  // first key the least recently used, which is the one set() evicts.
  #touch(key: string, hit: Entry): void {
    this.#map.delete(key);
    this.#map.set(key, hit);
  }

  /**
   * Get-or-compute, caching the resolved value. During an upstream outage
   * (isOutage) a value within the stale window is served instead and noted as
   * stale. Anything else (a bug, a 404, a rejected key) propagates: stale data
   * must not hide it.
   */
  async wrapStaleOnError<T>(key: string, compute: () => Promise<T | Degraded<T>>): Promise<T> {
    const fresh = this.get<T>(key);
    if (fresh !== undefined) return fresh;
    let computed: Computed<T | Degraded<T>>;
    try {
      computed = await this.#dedupe(key, compute);
    } catch (err) {
      const stale = isOutage(err) ? this.#usableStale<T>(key, err) : undefined;
      if (stale === undefined) throw err;
      return stale;
    }
    // The shared compute's own notes apply to every caller it serves, not just
    // the one whose context ran it, but only if its value is the one returned.
    if (!(computed.value instanceof Degraded)) {
      note(computed.notes);
      return computed.value;
    }
    const stale = this.#usableStale<T>(key, "the fresh result was partial");
    if (stale !== undefined) return stale;
    note({ ...computed.notes, partial: true });
    return computed.value.value;
  }

  // A cached value still inside the stale window, noted with its age and
  // logged with `why`. One past the window, or of unknown age (the clock
  // stepped back), is dropped for good.
  #usableStale<T>(key: string, why: unknown): T | undefined {
    const hit = this.#map.get(key);
    if (hit === undefined) return undefined;
    const ageMs = this.#now() - hit.storedAt;
    if (ageMs < 0 || ageMs > this.#ttlMs + this.#maxStaleMs) {
      this.#map.delete(key);
      return undefined;
    }
    this.#touch(key, hit);
    this.#logger?.warn(`serving stale cached value for "${key}"`, why);
    note({ staleAgeMs: ageMs });
    return hit.value as T;
  }

  // One in-flight compute per key, run in its own CallNotes record so what it
  // used is separate from any caller's. A result built from stale or partial
  // input, or degraded itself, is returned but not cached. A rejection reaches
  // every waiter and frees the slot.
  #dedupe<T>(key: string, compute: () => Promise<T>): Promise<Computed<T>> {
    const inFlight = this.#pending.get(key) as Promise<Computed<T>> | undefined;
    if (inFlight) return inFlight;
    const notes: CallNotes = {};
    const promise = callNotes
      .run(notes, compute)
      .then((value) => {
        const clean = notes.staleAgeMs === undefined && !notes.partial;
        if (clean && !(value instanceof Degraded)) this.set(key, value);
        return { value, notes };
      })
      .finally(() => this.#pending.delete(key));
    this.#pending.set(key, promise);
    return promise;
  }
}

interface Computed<T> {
  value: T;
  notes: CallNotes;
}
