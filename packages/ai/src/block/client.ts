import { rcError, type ForwardFn } from "@routecraft/routecraft";
import type { BlockClient } from "./types.ts";

/**
 * Build the {@link BlockClient} handed to a block resolver function.
 *
 * Wraps the {@link ForwardFn} the agent step was handed, the same one route
 * `.error()` handlers receive. Called with none at all (the adapter invoked
 * by hand, outside any step), `forward` rejects with AI1001 so a resolver
 * does not silently no-op. A step that ran with no route binding hands over
 * its own `forward`, which rejects with RC5001.
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
