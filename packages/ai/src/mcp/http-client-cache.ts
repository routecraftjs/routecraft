/**
 * Keyed cache of long-lived connections that are expensive to establish and
 * must be disposed exactly once.
 *
 * Caching the resolved value is not enough. Establishing a connection is
 * asynchronous, so a cache that stores the result leaves a window between the
 * miss and the write in which a second caller also misses, also connects, and
 * whose write replaces the first entry. The displaced connection is then
 * unreachable and never disposed, leaking it and its transport. Storing the
 * in-flight promise closes the window: the second caller joins the first.
 *
 * A rejected attempt evicts itself, so a transient failure does not poison the
 * key for the process lifetime.
 */
export interface DisposableEntry {
  dispose(): Promise<void>;
}

/** Keyed promise cache with identity-checked eviction. */
export interface ConnectionCache<T extends DisposableEntry> {
  /**
   * Return the in-flight or settled promise for `key`, starting one with
   * `create` on a miss. Concurrent callers for the same key share one promise.
   */
  getOrCreate(key: string, create: () => Promise<T>): Promise<T>;
  /**
   * Evict `key` only when it still holds `pending`, and dispose that entry.
   *
   * The identity check matters because attempts can overlap: a caller whose
   * own attempt failed must not evict and dispose the healthy connection a
   * concurrent caller has since cached under the same key.
   */
  evict(key: string, pending: Promise<T>): Promise<void>;
  /** Dispose every cached entry and empty the cache. */
  disposeAll(onError: (error: unknown, key: string) => void): Promise<void>;
}

export function createConnectionCache<
  T extends DisposableEntry,
>(): ConnectionCache<T> {
  const entries = new Map<string, Promise<T>>();

  return {
    getOrCreate(key, create) {
      const existing = entries.get(key);
      if (existing) return existing;

      const pending = create();
      entries.set(key, pending);
      // A failed attempt must not stay cached, or every later call replays the
      // same rejection. Evicting here rather than at the call site keeps the
      // cache consistent even for callers that never inspect the rejection.
      void pending.catch(() => {
        if (entries.get(key) === pending) entries.delete(key);
      });
      return pending;
    },

    async evict(key, pending) {
      if (entries.get(key) === pending) entries.delete(key);
      // A rejected attempt has nothing to dispose, and its rejection is
      // already the failure the caller is handling.
      await pending.then(
        (entry) => entry.dispose(),
        () => undefined,
      );
    },

    async disposeAll(onError) {
      for (const [key, pending] of entries) {
        try {
          const entry = await pending;
          await entry.dispose();
        } catch (error) {
          onError(error, key);
        }
      }
      entries.clear();
    },
  };
}
