import type { CraftContext } from "./context.ts";

/**
 * One in-flight exchange as the lineage index records it.
 *
 * @internal
 */
export interface LineageEntry {
  /** The route the exchange runs in. */
  readonly routeId: string;
  /**
   * The in-process exchange that started this one, fixed when the entry is
   * made. What the `event()` guard walks. Unlike {@link causationId} it is
   * never re-stamped, and it is never a cause a door adopted from a caller:
   * an id from the wire may name any exchange, and a walk that followed it
   * would let a caller decide what an `event()` route counts as its own.
   */
  readonly parentId: string | undefined;
  /** The cause the exchange reports, which `.correlate()` may re-stamp. */
  causationId: string | undefined;
  /**
   * Whether the exchange joined its journey rather than being called into
   * it: a door adopted the correlation id from a caller, `.correlate()`
   * re-stamped it, or an `event()` delivery continued it, or it descends
   * from an exchange that did. Such a correlation id is a claim, so nothing
   * that reaches a particular person or session may resolve by it.
   */
  joined: boolean;
  /** The entry whose departure removes this one, when it was attached under one. */
  root: string | undefined;
  /**
   * The `traceparent` a door adopted for this exchange, which the telemetry
   * plugin makes the remote parent of its span when no causing span is live.
   */
  readonly remoteParent?: string;
}

/** How a root comes into the index. */
export interface LineageRootOptions {
  /** The cause the exchange reports. */
  readonly causationId?: string | undefined;
  /** The in-process exchange that started it; see {@link LineageEntry.parentId}. */
  readonly parentId?: string | undefined;
  /** Whether it joined its journey; see {@link LineageEntry.joined}. */
  readonly joined?: boolean;
  /** The `traceparent` a door adopted for it. */
  readonly remoteParent?: string | undefined;
}

/**
 * The deepest chain a walk follows before giving up. A real call chain is a
 * handful of hops; the bound only stops a cycle from spinning a synchronous
 * event delivery forever.
 */
const MAX_WALK = 256;

/**
 * Every exchange a context has in flight, keyed by exchange id, with the
 * route it runs in, the exchange that started it, and the cause it reports.
 *
 * Three readers: the `event()` source walks it to recognise events its own
 * exchanges caused, including those of routes it called; the context reads
 * it to fill `causationId` and `remoteParent` on lifecycle events; and the
 * ACP surface asks it whether an exchange's correlation id was claimed
 * rather than inherited before resolving a person's editor by it.
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
 *   recognised.
 *
 * A route that stops forgets its entries ({@link LineageIndex.forgetRoute}),
 * so an exchange abandoned by a forced stop, which never reaches the code that
 * leaves, does not stay behind.
 *
 * @internal
 */
export class LineageIndex {
  readonly #entries = new Map<string, LineageEntry>();
  readonly #descendants = new Map<string, string[]>();

  /**
   * Enter a root. It joined its journey when the options say so or when the
   * exchange that started it did.
   *
   * @param exchangeId - The exchange being run
   * @param routeId - The route running it
   * @param options - Its cause, its in-process parent, and how it joined
   * @returns The leave function; calling it removes the root and every descendant attached under it
   */
  enter(
    exchangeId: string,
    routeId: string,
    options: LineageRootOptions = {},
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
      const parent =
        options.parentId === undefined
          ? undefined
          : this.#entries.get(options.parentId);
      this.#entries.set(exchangeId, {
        routeId,
        parentId: options.parentId,
        causationId: options.causationId,
        joined: options.joined === true || parent?.joined === true,
        root: undefined,
        ...(options.remoteParent !== undefined
          ? { remoteParent: options.remoteParent }
          : {}),
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
   * @param parentId - The exchange it came from, recorded as its parent and its cause
   */
  attach(exchangeId: string, routeId: string, parentId: string): void {
    const parent = this.#entries.get(parentId);
    if (parent === undefined || this.#entries.has(exchangeId)) return;
    const root = parent.root ?? parentId;
    this.#entries.set(exchangeId, {
      routeId,
      parentId,
      causationId: parentId,
      joined: parent.joined,
      root,
    });
    const list = this.#descendants.get(root);
    if (list) list.push(exchangeId);
    else this.#descendants.set(root, [exchangeId]);
  }

  /**
   * Re-stamp the cause an in-flight exchange reports, after `.correlate()`.
   * The in-process parent the guard walks is left as it was.
   *
   * @param exchangeId - The exchange re-stamped
   * @param causationId - Its new cause, or undefined
   * @param joined - Whether its correlation id changed, which makes it a claim
   */
  recause(
    exchangeId: string,
    causationId: string | undefined,
    joined: boolean,
  ): void {
    const entry = this.#entries.get(exchangeId);
    if (entry === undefined) return;
    entry.causationId = causationId;
    if (joined) entry.joined = true;
  }

  /**
   * Whether `exchangeId`, or an in-process exchange it descends from that is
   * still in flight, runs in `routeId`.
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
      id = entry.parentId;
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

  /**
   * Forget every entry of a route, when it stops. An exchange a forced stop
   * abandoned never reaches its leave; without this its entry would outlive
   * the route.
   *
   * @param routeId - The route that stopped
   */
  forgetRoute(routeId: string): void {
    for (const [id, entry] of this.#entries) {
      if (entry.routeId === routeId) this.#leave(id);
    }
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
