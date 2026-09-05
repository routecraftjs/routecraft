/**
 * A set that forgets its oldest members past a bound. Per-process memory
 * about sessions must not grow with every session a long-lived process
 * has ever served; what it forgets is repaired the way it was first
 * learnt (an index write, a follow-up request), one extra step per
 * forgotten key.
 *
 * @internal
 */
export class BoundedSet<T> {
  private readonly members = new Set<T>();

  constructor(private readonly bound: number) {}

  has(value: T): boolean {
    return this.members.has(value);
  }

  add(value: T): void {
    // Re-adding moves the key to the young end, so what is in use stays.
    this.members.delete(value);
    this.members.add(value);
    if (this.members.size > this.bound) {
      const oldest = this.members.values().next().value as T;
      this.members.delete(oldest);
    }
  }
}

/**
 * A map with the same forgetting rule as {@link BoundedSet}, plus pins: a
 * pinned key is never the one forgotten, for an entry the owner knows it
 * will need (a session with work outstanding and no stored continuation,
 * whose next turn can only run on the request kept here). The bound then
 * applies to the unpinned entries.
 *
 * @internal
 */
export class BoundedMap<K, V> {
  private readonly entries = new Map<K, V>();
  private readonly pinned = new Set<K>();

  constructor(private readonly bound: number) {}

  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.bound) {
      for (const candidate of this.entries.keys()) {
        if (this.pinned.has(candidate)) continue;
        this.entries.delete(candidate);
        break;
      }
    }
  }

  /** Keep the entry through evictions until {@link unpin}. */
  pin(key: K): void {
    if (this.entries.has(key)) this.pinned.add(key);
  }

  unpin(key: K): void {
    this.pinned.delete(key);
  }
}

/** Enough sessions to remember for any one process; the rest is repaired. */
export const SESSION_MEMORY_BOUND = 4096;
