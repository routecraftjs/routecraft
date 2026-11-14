import { rcError, type ForwardFn } from "@routecraft/routecraft";
import type { BlockClient } from "./types.ts";

/**
 * Build the {@link BlockClient} handed to a block resolver function.
 *
 * Wraps the {@link ForwardFn} the agent step was handed, the same one route
 * `.error()` handlers receive. When the step ran without one (a synthetic
 * exchange in a test), `forward` rejects
 * with AI1001 so a resolver does not silently no-op and downstream
 * `.error()` handlers can pattern-match on the failure mode.
 *
 * @internal
 */
export function makeBlockClient(stepForward?: ForwardFn): BlockClient {
  const forward: ForwardFn =
    stepForward ??
    (async () => {
      throw rcError("AI1001", undefined, {
        message:
          "Block resolver: client.forward() called but the exchange has no bound route. " +
          "Block resolvers can only forward when invoked through a real route dispatch.",
      });
    });
  return { forward };
}
