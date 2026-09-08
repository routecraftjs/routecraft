import { afterEach, expect, test } from "bun:test";
import { shutdownHandler } from "../src/shutdown.ts";
import type { CraftContext } from "../src/context.ts";

const makeContext = (stop: () => Promise<{ forced: boolean; pending: string[] }>) =>
  ({
    logger: {
      info: () => {},
      warn: () => {},
    },
    stop,
  }) as unknown as CraftContext;

const invoke = (signal: NodeJS.Signals): void => {
  const handler = process
    .listeners(signal)
    .find((listener) => listener.name === `${signal.toLowerCase()}Handler`);
  if (!handler) throw new Error(`No handler installed for ${signal}`);
  handler();
};

/**
 * @case Repeated graceful signals do not force an exit
 * @preconditions SIGINT starts a pending graceful shutdown, then SIGTERM and SIGINT arrive before it completes
 * @expectedResult The process exits cleanly once and never receives exit code 1
 */
test("repeated graceful signals remain idempotent", async () => {
  const exits: number[] = [];
  const originalExit = process.exit;
  process.exit = ((code: number) => {
    exits.push(code);
  }) as typeof process.exit;
  const deferred = Promise.withResolvers<{ forced: boolean; pending: string[] }>();
  const context = makeContext(() => deferred.promise);
  const cleanup = shutdownHandler(context);

  invoke("SIGINT");
  invoke("SIGINT");
  invoke("SIGTERM");
  invoke("SIGTERM");
  deferred.resolve({ forced: false, pending: [] });
  await Promise.resolve();
  await Promise.resolve();

  expect(exits).not.toContain(1);
  expect(exits).toContain(0);
  cleanup();
  process.exit = originalExit;
});

/**
 * @case SIGQUIT forces an immediate exit before graceful shutdown begins
 * @preconditions A shutdown handler is installed and SIGQUIT is invoked first
 * @expectedResult The process exits with code 1 and context.stop is not called
 */
test("SIGQUIT forces immediate exit before graceful shutdown", () => {
  const source = new URL("../src/shutdown.ts", import.meta.url).pathname;
  const script = `
    const { shutdownHandler } = await import(${JSON.stringify(source)});
    shutdownHandler({ logger: { info() {}, warn() {} }, stop: () => { throw new Error("stop called"); } });
    const force = process.listeners("SIGQUIT").find((listener) => listener.name === "sigquitHandler");
    force();
  `;
  const result = Bun.spawnSync([process.execPath, "-e", script]);

  expect(result.exitCode).toBe(1);
});

/**
 * @case SIGBREAK forces an immediate exit during graceful shutdown
 * @preconditions SIGINT has started a pending graceful shutdown, then SIGBREAK arrives
 * @expectedResult SIGBREAK invokes exit code 1 without waiting for context.stop
 */
test("SIGBREAK forces immediate exit during graceful shutdown", () => {
  const source = new URL("../src/shutdown.ts", import.meta.url).pathname;
  const script = `
    const { shutdownHandler } = await import(${JSON.stringify(source)});
    const context = { logger: { info() {}, warn() {} }, stop: () => new Promise(() => {}) };
    shutdownHandler(context);
    const graceful = process.listeners("SIGINT").find((listener) => listener.name === "sigintHandler");
    const force = process.listeners("SIGBREAK").find((listener) => listener.name === "sigbreakHandler");
    graceful();
    force();
  `;
  const result = Bun.spawnSync([process.execPath, "-e", script]);

  expect(result.exitCode).toBe(1);
});

/**
 * @case Cleanup removes every shutdown signal handler
 * @preconditions A handler is installed and its cleanup callback is called
 * @expectedResult SIGINT, SIGTERM, SIGQUIT, and SIGBREAK listener counts return to their baseline
 */
test("cleanup removes all shutdown signal handlers", () => {
  const before = new Map(
    ["SIGINT", "SIGTERM", "SIGQUIT", "SIGBREAK"].map((signal) => [
      signal,
      process.listenerCount(signal),
    ]),
  );
  const cleanup = shutdownHandler(makeContext(async () => ({ forced: false, pending: [] })));

  cleanup();

  for (const signal of before.keys()) {
    expect(process.listenerCount(signal)).toBe(before.get(signal));
  }
});

afterEach(() => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGQUIT", "SIGBREAK"] as const) {
    process.removeAllListeners(signal);
  }
});
