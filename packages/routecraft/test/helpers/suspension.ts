import type { SuspensionStore } from "../../src/index.ts";

// Shared with the ecosystem suites; core's consumers import through here.
export { asSuspended, suspending } from "@routecraft/testing";

/**
 * A store that behaves exactly like `backing` except for the methods named
 * in `overrides`. Delegation is by proxy rather than by hand, so a method
 * added to `SuspensionStore` reaches every fake without editing it; a
 * hand-written list would surface a missed method as `undefined` at call
 * time inside whatever test happened to hit it first.
 */
export function storeWith(
  backing: SuspensionStore,
  overrides: Partial<SuspensionStore>,
): SuspensionStore {
  return new Proxy(backing, {
    get(target, prop, receiver) {
      // Own keys only: `in` would intercept Object.prototype members like
      // `constructor` and hand back unbound built-ins instead of delegating.
      if (Object.hasOwn(overrides, prop)) {
        return Reflect.get(overrides, prop, receiver);
      }
      const value = Reflect.get(target, prop, target) as unknown;
      // Bound to the real instance: the memory backend's private fields are
      // only reachable with it as `this`.
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as SuspensionStore;
}
