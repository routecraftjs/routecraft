/**
 * A map that forgets its oldest entries past a bound, plus pins: a pinned
 * key is never forgotten, for an entry the owner knows it will need (a
 * session with work outstanding and no stored continuation, whose next turn
 * can only run on the request kept here). Per-process memory about sessions
 * must not grow with every session a long-lived process has ever served;
 * what it forgets is repaired the way it was first learnt, one extra step
 * per forgotten key. The bound counts the unpinned entries only, so pinned
 * ones never crowd out a new entry, and an unpin trims what the pin was
 * holding open.
 *
 * @internal
 */
export class BoundedMap<K, V> {
  private readonly entries = new Map<K, V>();
  private readonly pinned = new Set<K>();

  constructor(private readonly bound: number) {}

  has(key: K): boolean {
    return this.entries.has(key);
  }

  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    // A read moves the key to the young end, so what is in use stays.
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    this.trimUnpinned();
  }

  /** Keep the entry through evictions until {@link unpin}. */
  pin(key: K): void {
    if (this.entries.has(key)) this.pinned.add(key);
  }

  unpin(key: K): void {
    this.pinned.delete(key);
    this.trimUnpinned();
  }

  private trimUnpinned(): void {
    while (this.entries.size - this.pinned.size > this.bound) {
      for (const candidate of this.entries.keys()) {
        if (this.pinned.has(candidate)) continue;
        this.entries.delete(candidate);
        break;
      }
    }
  }
}

/** Enough sessions to remember for any one process; the rest is repaired. */
export const SESSION_MEMORY_BOUND = 4096;
