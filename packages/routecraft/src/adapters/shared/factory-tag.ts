/**
 * Factory-tagging primitive used to mark adapter instances with the factory
 * that produced them. Enables the testing override API to resolve which mock
 * applies to an adapter instance at route execution time.
 *
 * Two non-enumerable symbol properties are stamped on the instance:
 * - {@link RC_ADAPTER_FACTORY} - reference to the factory function
 * - {@link RC_ADAPTER_ARGS} - the args passed to the factory
 *
 * Symbols are global (`Symbol.for`) so cross-instance equality holds if the
 * package is loaded more than once via different resolutions.
 *
 * @internal
 */

export const RC_ADAPTER_FACTORY: unique symbol = Symbol.for(
  "routecraft.adapter.factory",
);

export const RC_ADAPTER_ARGS: unique symbol = Symbol.for(
  "routecraft.adapter.args",
);

/**
 * Stamp an adapter instance with its factory and construction args.
 * Properties are non-enumerable so they do not appear in logs, JSON, or spread.
 *
 * @param adapter - Adapter instance returned by a factory
 * @param factory - Factory function that produced the instance (self-reference)
 * @param args - Args that were passed to the factory
 * @returns The same adapter instance (for chaining)
 *
 * @internal
 */
export function tagAdapter<A extends object>(
  adapter: A,
  factory: unknown,
  args: unknown[],
): A {
  Object.defineProperty(adapter, RC_ADAPTER_FACTORY, {
    value: factory,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  Object.defineProperty(adapter, RC_ADAPTER_ARGS, {
    value: args,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return adapter;
}

/**
 * Read the factory reference from a tagged adapter instance.
 *
 * @param adapter - Candidate adapter instance
 * @returns The factory function, or undefined if not tagged
 *
 * @internal
 */
export function getAdapterFactory(adapter: unknown): unknown | undefined {
  if (adapter === null || typeof adapter !== "object") return undefined;
  return (adapter as Record<symbol, unknown>)[RC_ADAPTER_FACTORY];
}

/**
 * Read the construction args from a tagged adapter instance.
 *
 * @param adapter - Candidate adapter instance
 * @returns The args array, or undefined if not tagged
 *
 * @internal
 */
export function getAdapterArgs(adapter: unknown): unknown[] | undefined {
  if (adapter === null || typeof adapter !== "object") return undefined;
  return (adapter as Record<symbol, unknown>)[RC_ADAPTER_ARGS] as
    | unknown[]
    | undefined;
}
