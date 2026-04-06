import type { CraftContext } from "./context.ts";

/**
 * Register SIGINT/SIGTERM handlers for graceful two-stage shutdown.
 *
 * **First signal** (Ctrl+C): stops accepting new requests, drains in-flight
 * routes, runs plugin teardown, then exits cleanly.
 *
 * **Second signal** (Ctrl+C again): forces an immediate exit for when
 * graceful shutdown is stuck or taking too long.
 *
 * @param context - A built `CraftContext` to shut down on signal
 *
 * @example
 * ```typescript
 * const { context } = await builder.build();
 * shutdownHandler(context);
 * await context.start();
 * ```
 *
 * @experimental
 */
export function shutdownHandler(context: CraftContext): () => void {
  let shuttingDown = false;

  const onSignal = async (signal: string) => {
    if (shuttingDown) {
      context.logger.warn(
        { signal },
        "Received signal during shutdown; forcing exit now",
      );
      process.exit(1);
    }

    shuttingDown = true;
    context.logger.info(
      { signal },
      "Received signal; shutting down gracefully (press Ctrl+C again to force)",
    );

    try {
      await context.stop();
      context.logger.info("Cleanup complete");
      process.exit(0);
    } catch (err) {
      context.logger.warn({ err }, "Error during graceful shutdown; exiting");
      process.exit(1);
    }
  };

  const sigintHandler = () => void onSignal("SIGINT");
  const sigtermHandler = () => void onSignal("SIGTERM");
  process.on("SIGINT", sigintHandler);
  process.on("SIGTERM", sigtermHandler);

  return () => {
    process.off("SIGINT", sigintHandler);
    process.off("SIGTERM", sigtermHandler);
  };
}
