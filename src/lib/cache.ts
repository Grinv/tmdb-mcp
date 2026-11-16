// Tiny in-memory TTL cache for read endpoints. Expired entries are kept
// (bounded by max size) as a stale fallback for when the upstream is down, for
// at most `maxStaleMs` past expiry (RFC 5861's stale-if-error).
//
// One instance serves all of a client's endpoints, each storing its own shape
// under its own key (movie detail, credits, genre map, ...). So the type
// parameter is on each method, not on the class: callers get back the type
// their own `compute()`/`value` has.

import { AsyncLocalStorage } from "node:async_hooks";
import { isOutage } from "./errors.ts";
import type { Logger } from "./logger.ts";

/**
 * Build a deterministic cache key from a stable resource path (e.g.
 * `movie:${id}`) plus the params that vary the *shaped* response (region,
 * language, ...). Named fields make those dimensions visible at the call site
 * and independent of order. A dimension left out of a key would leak one
 * request's response into another's cache slot.
 */
export function cacheKey(
  resource: string,
  dims: Record<string, string | number | boolean | undefined> = {},
): string {
  const parts = Object.keys(dims)
    .sort()
    .map((k) => `${k}=${dims[k] ?? ""}`);
  return parts.length ? `${resource}:${parts.join(":")}` : resource;
}

export interface Clock {
  /** Wall clock (ms): counts sleep, but can be stepped. */
  wall(): number;
  /** Monotonic clock (ms): never stepped, but stops while the machine sleeps. */
  mono(): number;
}

const SYSTEM_CLOCK: Clock = { wall: () => Date.now(), mono: () => performance.now() };

// Stored on both clocks; see TtlCache's #ageMs.
interface Entry {
  value: unknown;
  wallAt: number;
  monoAt: number;
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
  readonly #clock: Clock;
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
    /** Injectable for tests. */
    clock?: Clock;
  }) {
    this.#ttlMs = opts.ttlMs;
    this.#max = opts.max ?? 500;
    this.#maxStaleMs = opts.maxStaleMs ?? Infinity;
    this.#logger = opts.logger;
    this.#clock = opts.clock ?? SYSTEM_CLOCK;
  }

  // An entry's real age is never less than the monotonic delta and, between
  // clock steps, equals the wall delta; the larger of the two is never
  // negative and counts sleep. Limits no clock can see past: a step forward
  // looks exactly like sleep, so it ages entries (and may drop them), and a
  // step back during sleep understates the age by the smaller of the two.
  #ageMs(hit: Entry): number {
    return Math.max(this.#clock.wall() - hit.wallAt, this.#clock.mono() - hit.monoAt);
  }

  /** Fresh (non-expired) value, or undefined. */
  get<T>(key: string): T | undefined {
    const hit = this.#map.get(key);
    if (!hit || this.#ageMs(hit) >= this.#ttlMs) return undefined;
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
    this.#map.set(key, { value, wallAt: this.#clock.wall(), monoAt: this.#clock.mono() });
  }

  // Map iterates in insertion order, so re-inserting on every hit keeps the
  // first key the least recently used, which is the one set() evicts.
  #touch(key: string, hit: Entry): void {
    this.#map.delete(key);
    this.#map.set(key, hit);
  }

  /**
   * Get-or-compute, caching a complete result. In order: a fresh value; else
   * the compute's complete result; else, when the compute hit an outage
   * (isOutage) or came back degraded, a complete copy within the stale window,
   * noted stale; else the degraded result, noted partial. Any other failure (a
   * bug, a 404, a rejected key) propagates: stale data must not hide it.
   */
  async wrapStaleOnError<T>(key: string, compute: () => Promise<T | Degraded<T>>): Promise<T> {
    const fresh = this.get<T>(key);
    if (fresh !== undefined) return fresh;

    let partial: Computed<Degraded<T>> | undefined;
    let outage: unknown;
    try {
      const computed = await this.#dedupe(key, compute);
      // The shared compute's notes reach every caller it serves, but only
      // with its own value.
      if (!(computed.value instanceof Degraded)) {
        note(computed.notes);
        return computed.value;
      }
      partial = { value: computed.value, notes: computed.notes };
    } catch (err) {
      if (!isOutage(err)) throw err;
      outage = err;
    }

    const stale = this.#stale(key);
    if (stale) {
      note({ staleAgeMs: stale.ageMs });
      return stale.value as T;
    }
    if (partial === undefined) throw outage;
    note({ ...partial.notes, partial: true });
    return partial.value.value;
  }

  // The entry for `key` if it is still within the stale window; one past it
  // is dropped for good.
  #stale(key: string): { value: unknown; ageMs: number } | undefined {
    const hit = this.#map.get(key);
    if (hit === undefined) return undefined;
    const ageMs = this.#ageMs(hit);
    if (ageMs > this.#ttlMs + this.#maxStaleMs) {
      this.#map.delete(key);
      return undefined;
    }
    this.#touch(key, hit);
    return { value: hit.value, ageMs };
  }

  // One in-flight compute per key, run in its own CallNotes record so what it
  // used is separate from any caller's. A result built from stale or partial
  // input, or degraded itself, is returned but not cached. A rejection reaches
  // every waiter and frees the slot. An outage or a partial result is logged
  // here, once per refresh however many callers wait on it, whether or not a
  // stale copy then stands in.
  #dedupe<T>(key: string, compute: () => Promise<T>): Promise<Computed<T>> {
    const inFlight = this.#pending.get(key) as Promise<Computed<T>> | undefined;
    if (inFlight) return inFlight;
    const notes: CallNotes = {};
    const promise = callNotes
      .run(notes, compute)
      .then(
        (value) => {
          if (value instanceof Degraded) {
            this.#logger?.warn(`refresh of "${key}" was partial`);
          } else if (notes.staleAgeMs === undefined && !notes.partial) {
            this.set(key, value);
          }
          return { value, notes };
        },
        (err: unknown) => {
          if (isOutage(err)) this.#logger?.warn(`refresh of "${key}" failed`, err);
          throw err;
        },
      )
      .finally(() => this.#pending.delete(key));
    this.#pending.set(key, promise);
    return promise;
  }
}

interface Computed<T> {
  value: T;
  notes: CallNotes;
}
