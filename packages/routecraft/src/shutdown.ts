import type { CraftContext } from "./context.ts";

/**
 * Register SIGINT/SIGTERM handlers for graceful two-stage shutdown.
 *
 * **First signal** (Ctrl+C): closes intake so sources stop producing, lets
 * in-flight exchanges run to their natural end, runs plugin teardown, then
 * exits 0. In-flight work is NOT cancelled here; that is the difference
 * between the two signals.
 *
 * **Second signal** (Ctrl+C again): forces an immediate exit for when
 * graceful shutdown is stuck or taking too long.
 *
 * Stage one is bounded by `shutdown: { timeout }` even without a second
 * signal, which is what an orchestrator needs: it sends one SIGTERM and then
 * SIGKILLs, so there is no second Ctrl-C coming. On that deadline in-flight
 * execution is abandoned and the process exits 1, so exit-code-sensitive
 * tooling can tell a forced shutdown from a clean one.
 *
 * @param context - A built `CraftContext` to shut down on signal
 *
 * @example
 * ```typescript
 * const { context } = await builder.build();
 * shutdownHandler(context);
 * await context.start();
 * ```
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
      const outcome = await context.stop();
      context.logger.info("Cleanup complete");
      // Non-zero on a forced stop: work was abandoned, and a caller that
      // reads exit codes must not be told that went cleanly. The reason is
      // in the log line the forced stage writes.
      process.exit(outcome.forced ? 1 : 0);
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
