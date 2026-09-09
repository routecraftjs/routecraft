import {
  isDeferred,
  type CraftConfig,
  type Deferred,
} from "@routecraft/routecraft";

/**
 * A config whose deferral runtime is the in-memory backend with an
 * ephemeral signing key. `testContext()` substitutes both as soon as a
 * `deferral` block is present, so every deferring test declares one.
 */
export function deferring(): CraftConfig {
  return { deferral: {} };
}

/** Read the acknowledgment execution one answered with. */
export function asDeferred(value: unknown): Deferred {
  if (!isDeferred(value)) {
    throw new Error(`expected a Deferred acknowledgment, got ${String(value)}`);
  }
  return value;
}
