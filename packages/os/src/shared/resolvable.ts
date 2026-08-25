import type { Exchange } from "@routecraft/routecraft";

/** Option value that can be static or resolved from the exchange. */
export type Resolvable<T, V> = V | ((exchange: Exchange<T>) => V);

/**
 * Collapse a {@link Resolvable} against the exchange it belongs to.
 * Returns `undefined` for an absent option so callers can apply their
 * own default without a separate presence check.
 */
export function resolve<T, V>(
  val: Resolvable<T, V> | undefined,
  exchange: Exchange<T>,
): V | undefined {
  if (val === undefined) return undefined;
  if (typeof val === "function")
    return (val as (e: Exchange<T>) => V)(exchange);
  return val as V;
}
