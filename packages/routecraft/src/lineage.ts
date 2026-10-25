import type { CraftContext } from "./context.ts";

/**
 * One in-flight exchange as the lineage index records it.
 *
 * @internal
 */
export interface LineageEntry {
  /** The route the exchange runs in. */
  readonly routeId: string;
  /** The id of the exchange that caused this one, absent on a chain root. */
  causationId: string | undefined;
  /** The entry whose departure removes this one, when it was attached under one. */
  root: string | undefined;
  /**
   * The `traceparent` a door adopted for this exchange, which the telemetry
   * plugin makes the remote parent of its span when no causing span is live.
   */
  readonly remoteParent?: string;
}

/**
 * The deepest causation chain a walk follows before giving up. A real call
 * chain is a handful of hops; the bound only stops a cycle someone stitched
 * with `.correlate()` from spinning a synchronous event delivery forever.
 */
const MAX_WALK = 256;

/**
 * Every exchange a context has in flight, keyed by exchange id, with the
 * route it runs in and the exchange that caused it.
 *
 * Its one reader is the `event()` source, which must recognise an event its
 * own exchanges caused, including those of routes it called. Before the
 * causation header the source recognised them by correlation id, which only
 * worked because every delivery started a new chain; a delivery now continues
 * the chain of the exchange that caused the event, so the causing chain's
 * unrelated exchanges share the correlation and a correlation test would drop
 * them.
 *
 * Two kinds of entry:
 *
 * - A root, entered by whatever runs the exchange (a route's handler, its
 *   error channel, a continuation, a debounce release) immediately before the
 *   exchange emits its first event, and left after its terminal event. Event
 *   delivery is synchronous, so an event is always checked while its
 *   exchange is still entered.
 * - A descendant (a clone for `.tap()`, `.multicast()` or `.dispatch()`, a
 *   `.split()` child), attached under the root of the exchange it came from
 *   and removed when that root leaves. It never outlives its root in the
 *   index, which bounds the index by what is in flight; a background
 *   descendant still running after its root completed is no longer
 *   recognised, the same limit the correlation set had.
 *
 * @internal
 */
export class LineageIndex {
  readonly #entries = new Map<string, LineageEntry>();
  readonly #descendants = new Map<string, string[]>();

  /**
   * Enter a root.
   *
   * @param exchangeId - The exchange being run
   * @param routeId - The route running it
   * @param causationId - The exchange that caused it, if any
   * @param remoteParent - The `traceparent` a door adopted for it, if any
   * @returns The leave function; calling it removes the root and every descendant attached under it
   */
  enter(
    exchangeId: string,
    routeId: string,
    causationId: string | undefined,
    remoteParent?: string,
  ): () => void {
    const existing = this.#entries.get(exchangeId);
    // Re-entering a root already present keeps the first entry and its
    // descendants: only the outermost leave removes them.
    if (existing !== undefined && existing.root === undefined) return () => {};
    if (existing !== undefined) {
      // A descendant that now runs on its own (a debounce release outliving
      // the arrival it was cloned from) becomes a root, so its own leave and
      // not its old root's removes it.
      existing.root = undefined;
    } else {
      this.#entries.set(exchangeId, {
        routeId,
        causationId,
        root: undefined,
        ...(remoteParent !== undefined ? { remoteParent } : {}),
      });
    }
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.#leave(exchangeId);
    };
  }

  /**
   * Attach a descendant under the root of `parentId`. A no-op when the
   * parent is not in flight, so a clone made outside any route leaves no
   * entry behind.
   *
   * @param exchangeId - The descendant
   * @param routeId - The route it runs in
   * @param parentId - The exchange it came from, recorded as its cause
   */
  attach(exchangeId: string, routeId: string, parentId: string): void {
    const parent = this.#entries.get(parentId);
    if (parent === undefined || this.#entries.has(exchangeId)) return;
    const root = parent.root ?? parentId;
    this.#entries.set(exchangeId, { routeId, causationId: parentId, root });
    const list = this.#descendants.get(root);
    if (list) list.push(exchangeId);
    else this.#descendants.set(root, [exchangeId]);
  }

  /**
   * Point an in-flight exchange at a new cause, after `.correlate()`.
   *
   * @param exchangeId - The exchange re-stamped
   * @param causationId - Its new cause, or undefined to make it a chain root
   */
  recause(exchangeId: string, causationId: string | undefined): void {
    const entry = this.#entries.get(exchangeId);
    if (entry) entry.causationId = causationId;
  }

  /**
   * Whether `exchangeId`, or an exchange it descends from that is still in
   * flight, runs in `routeId`.
   *
   * @param exchangeId - The exchange an event names
   * @param routeId - The route asking
   */
  descendsFrom(exchangeId: string, routeId: string): boolean {
    let id: string | undefined = exchangeId;
    for (let hop = 0; id !== undefined && hop < MAX_WALK; hop++) {
      const entry = this.#entries.get(id);
      if (entry === undefined) return false;
      if (entry.routeId === routeId) return true;
      id = entry.causationId;
    }
    return false;
  }

  /**
   * The entry for an in-flight exchange.
   *
   * @param exchangeId - The exchange to look up
   */
  get(exchangeId: string): LineageEntry | undefined {
    return this.#entries.get(exchangeId);
  }

  /** How many exchanges are in flight. */
  get size(): number {
    return this.#entries.size;
  }

  #leave(exchangeId: string): void {
    this.#entries.delete(exchangeId);
    const descendants = this.#descendants.get(exchangeId);
    if (descendants === undefined) return;
    this.#descendants.delete(exchangeId);
    for (const id of descendants) {
      if (this.#entries.get(id)?.root === exchangeId) this.#entries.delete(id);
    }
  }
}

const INDEXES = new WeakMap<CraftContext, LineageIndex>();
/**
 * The same indexes by context id, for the telemetry plugin, which sees a
 * context's id on every event and never the context. Removed when the
 * context stops, through {@link forgetLineage}.
 */
const INDEXES_BY_ID = new Map<string, LineageIndex>();

/**
 * The lineage index of a context, created on first use.
 *
 * @param context - The context whose in-flight exchanges to index
 * @internal
 */
export function lineageOf(context: CraftContext): LineageIndex {
  let index = INDEXES.get(context);
  if (index === undefined) {
    index = new LineageIndex();
    INDEXES.set(context, index);
  }
  // Re-registered after a stop, for a context started again.
  if (!INDEXES_BY_ID.has(context.contextId)) {
    INDEXES_BY_ID.set(context.contextId, index);
  }
  return index;
}

/**
 * The lineage index of a context, if it made one, without creating it.
 *
 * @param context - The context to look up
 * @internal
 */
export function existingLineageOf(
  context: CraftContext,
): LineageIndex | undefined {
  return INDEXES.get(context);
}

/**
 * The lineage index of a context by its id, if the context made one.
 *
 * @param contextId - The context's id, as events carry it
 * @internal
 */
export function lineageById(contextId: string): LineageIndex | undefined {
  return INDEXES_BY_ID.get(contextId);
}

/**
 * Drop the id lookup for a stopped context, so a process that builds many
 * contexts (a test suite) does not keep every index alive.
 *
 * @param context - The context that stopped
 * @internal
 */
export function forgetLineage(context: CraftContext): void {
  INDEXES_BY_ID.delete(context.contextId);
}
