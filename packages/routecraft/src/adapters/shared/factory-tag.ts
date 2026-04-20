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
 * Stamp an adapter instance with its factory and construction args so that
 * `testContext().override(mockAdapter(factory, ...))` can match the instance
 * back to its factory at route execution time.
 *
 * Tagging is optional: adapters that skip it can still be mocked by passing
 * the adapter class to `mockAdapter(Class, ...)` (class-based resolution).
 * Tagging is preferred for single-role factories where the factory reference
 * is what users import and think in terms of.
 *
 * @param adapter - Adapter instance returned by a factory
 * @param factory - Factory function that produced the instance (self-reference)
 * @param args - Args that were passed to the factory
 * @returns The same adapter instance (for chaining)
 *
 * @experimental
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
 * Build the `args` tuple passed to {@link tagAdapter} from a variadic
 * factory's parameter list, trimming trailing `undefined` entries so the
 * recorded length matches what the user actually typed at the call site.
 *
 * Use this helper from every adapter factory that forwards user args to
 * `tagAdapter`, so mock authors see a consistent `args.length` across
 * adapters (for example, `mail()`, `mcp(endpoint)` and `http({})` all
 * record a single-element tuple when only one argument was passed).
 *
 * @example
 * ```ts
 * function mcp(endpoint, options?) {
 *   return tagAdapter(new McpAdapter(...), mcp, factoryArgs(endpoint, options));
 * }
 * ```
 *
 * @experimental
 */
export function factoryArgs(...args: unknown[]): unknown[] {
  let end = args.length;
  while (end > 0 && args[end - 1] === undefined) end--;
  return args.slice(0, end);
}

/**
 * Read the factory reference from a tagged adapter instance.
 *
 * @param adapter - Candidate adapter instance
 * @returns The factory function, or undefined if not tagged
 *
 * @internal
 */
export function getAdapterFactory(
  adapter: unknown,
): ((...args: unknown[]) => unknown) | undefined {
  if (adapter === null || typeof adapter !== "object") return undefined;
  return (adapter as Record<symbol, unknown>)[RC_ADAPTER_FACTORY] as
    | ((...args: unknown[]) => unknown)
    | undefined;
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
