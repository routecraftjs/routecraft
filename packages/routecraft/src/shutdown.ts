import type { CraftContext } from "./context.ts";

/**
 * Register SIGINT/SIGTERM handlers for graceful two-stage shutdown.
 *
 * **First signal** (Ctrl+C): closes intake so sources stop producing, lets
 * in-flight exchanges run to their natural end, runs plugin teardown, then
 * exits 0. In-flight work is NOT cancelled here. Repeated SIGINT/SIGTERM
 * signals are ignored while this graceful shutdown is in progress.
 *
 * **Dedicated force signals** (Ctrl+Backslash/SIGQUIT or Ctrl+Break/SIGBREAK):
 * force an immediate exit for when graceful shutdown is stuck or taking too
 * long. They force exit even when graceful shutdown has not started.
 *
 * Stage one is bounded by `shutdown: { timeout }` even without a force signal,
 * which is what an orchestrator needs: it sends one SIGTERM and then SIGKILLs,
 * so there is no dedicated force signal coming. On that deadline in-flight
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

  const onGracefulSignal = async (signal: "SIGINT" | "SIGTERM") => {
    if (shuttingDown) {
      context.logger.info(
        { signal },
        "Received repeated signal during graceful shutdown; ignoring",
      );
      return;
    }

    shuttingDown = true;
    context.logger.info(
      { signal },
      "Received signal; shutting down gracefully (use Ctrl+Backslash or Ctrl+Break to force)",
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

  const onForceSignal = (signal: "SIGQUIT" | "SIGBREAK") => {
    context.logger.warn({ signal }, "Received force signal; exiting now");
    process.exit(1);
  };

  const sigintHandler = () => void onGracefulSignal("SIGINT");
  const sigtermHandler = () => void onGracefulSignal("SIGTERM");
  const sigquitHandler = () => onForceSignal("SIGQUIT");
  const sigbreakHandler = () => onForceSignal("SIGBREAK");
  process.on("SIGINT", sigintHandler);
  process.on("SIGTERM", sigtermHandler);
  process.on("SIGQUIT", sigquitHandler);
  process.on("SIGBREAK", sigbreakHandler);

  return () => {
    process.off("SIGINT", sigintHandler);
    process.off("SIGTERM", sigtermHandler);
    process.off("SIGQUIT", sigquitHandler);
    process.off("SIGBREAK", sigbreakHandler);
  };
}
