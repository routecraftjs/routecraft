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
): F {
  Object.defineProperty(facade, "constructor", {
    value: delegate.constructor,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return facade;
}
