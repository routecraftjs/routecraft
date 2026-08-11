import {
  isSuspended,
  type CraftConfig,
  type Suspended,
  type SuspensionStore,
} from "../../src/index.ts";

/**
 * A config whose suspension runtime is the in-memory backend with an
 * ephemeral signing key. `testContext()` substitutes both as soon as a
 * `suspension` block is present, so every suspending test declares one.
 */
export function suspending(): CraftConfig {
  return { suspension: {} };
}

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

/** Read the acknowledgment execution one answered with. */
export function asSuspended(value: unknown): Suspended {
  if (!isSuspended(value)) {
    throw new Error(
      `expected a Suspended acknowledgment, got ${String(value)}`,
    );
  }
  return value;
}
