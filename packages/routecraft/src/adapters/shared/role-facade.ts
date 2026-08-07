/**
 * Stamp a role facade with the constructor of the adapter it delegates to.
 *
 * A factory that exposes only the slots matching its configured shape has to
 * build a plain object: keeping the class instance would leak the opposite
 * role (a read-shaped `carddav()` would still carry `send` on its prototype,
 * so `.to()` would resolve the wrong slot). The plain object costs the
 * adapter its identity, and `mockAdapter` matches an override either by
 * tagged factory OR by `adapter.constructor`, so a class-based
 * `mockAdapter(CarddavAdapter, ...)` would silently stop intercepting: the
 * route would hit the network in a test that reads as mocked.
 *
 * Re-pointing `constructor` at the delegate keeps that route working without
 * putting the prototype (and its unwanted slots) back in the chain. It is
 * non-enumerable, the same way a real prototype's `constructor` is, so
 * spreads and `Object.assign` of the facade are unaffected.
 *
 * @param facade - Role-slot object the factory returns
 * @param delegate - Adapter instance the facade forwards to
 * @returns The same facade, for chaining into `tagAdapter`
 * @internal
 */
export function withAdapterIdentity<F extends object>(
  facade: F,
  delegate: object,
  ...alsoStandsFor: readonly AdapterConstructor[]
): F {
  Object.defineProperty(facade, "constructor", {
    value: delegate.constructor,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  if (alsoStandsFor.length > 0) {
    // Constructors, not instances: a facade may front a delegate it builds
    // lazily, and naming the class keeps that delegate unconstructed until
    // its role is actually used.
    Object.defineProperty(facade, RC_ADAPTER_IDENTITIES, {
      value: new Set<unknown>([delegate.constructor, ...alsoStandsFor]),
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
  return facade;
}

/**
 * An adapter implementation class, as named for override matching. `never[]`
 * params make every concrete constructor assignable regardless of its own
 * signature; `abstract new` additionally admits abstract bases.
 *
 * @internal
 */
export type AdapterConstructor = abstract new (...args: never[]) => unknown;

/**
 * Every constructor a facade stands in for, when one facade fronts more than
 * one implementation class.
 *
 * `constructor` can only name one of them, but a facade that merges two role
 * implementations (mail's read side: an IDLE/polling source and a batch
 * enricher) is a legitimate target for a class-based mock of EITHER. Without
 * this, mocking the un-named class silently fails to intercept and the test
 * reaches the real service.
 *
 * @internal
 */
export const RC_ADAPTER_IDENTITIES: unique symbol = Symbol.for(
  "routecraft.adapter.identities",
);

/**
 * The constructors an adapter answers to for class-based override matching:
 * the full set when it is a multi-delegate facade, otherwise just its own.
 *
 * @internal
 */
export function adapterIdentities(adapter: unknown): ReadonlySet<unknown> {
  if (adapter === null || typeof adapter !== "object") return new Set();
  const declared = (
    adapter as { [RC_ADAPTER_IDENTITIES]?: ReadonlySet<unknown> }
  )[RC_ADAPTER_IDENTITIES];
  return (
    declared ?? new Set([(adapter as { constructor?: unknown }).constructor])
  );
}
