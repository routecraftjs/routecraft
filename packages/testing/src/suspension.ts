import {
  isSuspended,
  type CraftConfig,
  type Suspended,
} from "@routecraft/routecraft";

/**
 * A config whose suspension runtime is the in-memory backend with an
 * ephemeral signing key. `testContext()` substitutes both as soon as a
 * `suspension` block is present, so every suspending test declares one.
 */
export function suspending(): CraftConfig {
  return { suspension: {} };
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
