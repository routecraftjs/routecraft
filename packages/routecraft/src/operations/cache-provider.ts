import { LRUCache } from "lru-cache";

/**
 * Pluggable backend for the `.cache()` operation. Implementations decide
 * where cached values live (in-memory, Redis, file-backed, multi-tier,
 * etc.) and how eviction works. The contract is async-by-default so
 * remote backends fit without breaking the call signature.
 *
 * A reference implementation backed by `lru-cache` ships as
 * {@link MemoryCacheProvider}. Custom providers can be supplied
 * per-operation via `cache({ provider })`; a future change will allow a
 * global default to be set on `CraftConfig` (tracked in #112).
 *
 * Stampede protection (deduping concurrent computations for the same
 * key) is the provider's responsibility via {@link getOrCompute} so the
 * dedupe strategy can match the backend. In-memory providers track an
 * in-flight Promise per key; distributed providers like Redis can use a
 * lock key or rely on the underlying store's atomicity.
 *
 * @experimental Shipped with the first dual-mode wrapper after
 * `.error()`; see `.standards/resilience-wrappers.md`.
 */
export interface CacheProvider {
  /**
   * Fetch a value by key. Returns `undefined` when there is no entry
   * for the key (cache miss) or when the entry has expired. Treat
   * `undefined` as "miss"; do not store `undefined` as a cached value.
   *
   * @param key The cache key.
   */
  get(key: string): Promise<unknown | undefined>;

  /**
   * Store a value under `key`. When `ttl` is provided, the entry
   * expires after `ttl` milliseconds; otherwise the provider's default
   * expiry applies (which may be "never").
   *
   * @param key The cache key.
   * @param value The value to cache. Must not be `undefined`.
   * @param ttl Optional time to live in milliseconds.
   */
  set(key: string, value: unknown, ttl?: number): Promise<void>;

  /** Remove an entry by key. No-op if the key is absent. */
  delete(key: string): Promise<void>;

  /** Check existence without producing a "hit" side effect. */
  has(key: string): Promise<boolean>;

  /**
   * Atomic "get-or-compute" with stampede protection. On a hit, returns
   * the cached value. On a miss, runs `loader()` exactly once across
   * concurrent callers with the same key and caches the result before
   * resolving. If `loader` throws, the error propagates and nothing is
   * cached.
   *
   * Wrappers and adapters should prefer this over manual
   * `get` / `set` round-trips so the dedupe strategy stays with the
   * provider.
   *
   * @param key The cache key.
   * @param loader Producer for the cached value on a miss.
   * @param ttl Optional time to live for the produced value.
   */
  getOrCompute<T>(
    key: string,
    loader: () => Promise<T>,
    ttl?: number,
  ): Promise<T>;
}

/**
 * Construction options for {@link MemoryCacheProvider}.
 *
 * @experimental
 */
export interface MemoryCacheProviderOptions {
  /**
   * Maximum number of entries to keep. When the cache is full, the
   * least-recently-used entry is evicted to make room. Defaults to
   * 1000.
   */
  max?: number;
  /**
   * Default time to live in milliseconds, applied when a `set` call
   * omits `ttl`. Defaults to no expiry (entries live until evicted by
   * the LRU policy or explicitly deleted).
   */
  ttl?: number;
}

/**
 * Default in-process cache provider. Backed by `lru-cache` for
 * size-bounded LRU eviction with optional TTL, plus an in-flight
 * Promise map for stampede protection.
 *
 * Two instances are independent stores; the framework does not share
 * state across `MemoryCacheProvider` instances. The module-level
 * `defaultMemoryCacheProvider` is shared by every `.cache()` call that
 * does not supply its own provider.
 *
 * Thread-safe within the JS event loop: `getOrCompute` reads, registers
 * an in-flight Promise, and resolves it atomically with respect to
 * other JS turns on the same key. Across workers / processes the cache
 * is local to the host.
 *
 * @experimental
 */
export class MemoryCacheProvider implements CacheProvider {
  // `lru-cache` requires non-nullable values; the `CacheProvider`
  // contract already forbids storing `undefined`, so the cast at write
  // sites is type-only and never observable at runtime.
  readonly #lru: LRUCache<string, NonNullable<unknown>>;
  readonly #inFlight = new Map<string, Promise<unknown>>();

  constructor(options: MemoryCacheProviderOptions = {}) {
    this.#lru = new LRUCache<string, NonNullable<unknown>>({
      max: options.max ?? 1000,
      ...(options.ttl !== undefined ? { ttl: options.ttl } : {}),
    });
  }

  async get(key: string): Promise<unknown | undefined> {
    return this.#lru.get(key);
  }

  async set(key: string, value: unknown, ttl?: number): Promise<void> {
    if (value === undefined) return;
    const v = value as NonNullable<unknown>;
    if (ttl !== undefined) {
      this.#lru.set(key, v, { ttl });
    } else {
      this.#lru.set(key, v);
    }
  }

  async delete(key: string): Promise<void> {
    this.#lru.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.#lru.has(key);
  }

  async getOrCompute<T>(
    key: string,
    loader: () => Promise<T>,
    ttl?: number,
  ): Promise<T> {
    const cached = this.#lru.get(key);
    if (cached !== undefined) return cached as T;

    const existing = this.#inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = (async () => {
      try {
        const value = await loader();
        if (value !== undefined && value !== null) {
          const v = value as NonNullable<unknown>;
          if (ttl !== undefined) {
            this.#lru.set(key, v, { ttl });
          } else {
            this.#lru.set(key, v);
          }
        }
        return value;
      } finally {
        this.#inFlight.delete(key);
      }
    })();

    this.#inFlight.set(key, promise);
    return promise;
  }

  /**
   * Drop all entries. Mainly for tests and explicit invalidation.
   */
  clear(): void {
    this.#lru.clear();
    this.#inFlight.clear();
  }

  /** Number of live entries (excludes in-flight loaders). */
  get size(): number {
    return this.#lru.size;
  }
}

/**
 * Process-wide default provider used by `.cache()` when the call site
 * does not supply its own. Sized at 1000 entries, no default TTL. Tests
 * that need isolation should pass their own provider via
 * `cache({ provider: new MemoryCacheProvider() })` rather than mutating
 * this one.
 *
 * @internal
 */
export const defaultMemoryCacheProvider = new MemoryCacheProvider();
