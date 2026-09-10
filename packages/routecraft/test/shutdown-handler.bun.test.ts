import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { shutdownHandler } from "../src/shutdown.ts";
import type { CraftContext } from "../src/context.ts";

const makeContext = (
  stop: () => Promise<{ forced: boolean; pending: string[] }>,
) =>
  ({
    logger: {
      info: () => {},
      warn: () => {},
    },
    stop,
  }) as unknown as CraftContext;

const invoke = (
  signal: "SIGINT" | "SIGTERM" | "SIGQUIT" | "SIGBREAK",
): void => {
  const handler = process
    .listeners(signal)
    .find((listener) => listener.name === `${signal.toLowerCase()}Handler`);
  if (!handler) throw new Error(`No handler installed for ${signal}`);
  (handler as (receivedSignal: typeof signal) => void)(signal);
};

/**
 * @case Repeated graceful signals do not force an exit
 * @preconditions SIGINT starts a pending graceful shutdown, then SIGTERM and SIGINT arrive before it completes
 * @expectedResult The process exits cleanly once and never receives exit code 1
 */
test("repeated graceful signals remain idempotent", async () => {
  const exits: number[] = [];
  const originalExit = process.exit;
  const exit = Promise.withResolvers<void>();
  process.exit = ((code: number) => {
    exits.push(code);
    exit.resolve();
  }) as typeof process.exit;
  const deferred = Promise.withResolvers<{
    forced: boolean;
    pending: string[];
  }>();
  const context = makeContext(() => deferred.promise);
  const cleanup = shutdownHandler(context);
  try {
    invoke("SIGINT");
    invoke("SIGINT");
    invoke("SIGTERM");
    invoke("SIGTERM");
    deferred.resolve({ forced: false, pending: [] });
    await exit.promise;

    expect(exits).not.toContain(1);
    expect(exits).toContain(0);
  } finally {
    cleanup();
    process.exit = originalExit;
  }
});

/**
 * @case SIGQUIT forces an immediate exit before graceful shutdown begins
 * @preconditions A shutdown handler is installed and SIGQUIT is invoked first
 * @expectedResult The handler requests and records process.exit code 1, and context.stop is not called
 */
test("SIGQUIT forces immediate exit before graceful shutdown", () => {
  const source = new URL("../src/shutdown.ts", import.meta.url).href;
  const script = `
    const { shutdownHandler } = await import(${JSON.stringify(source)});
    const result = { exits: [], stopCalled: false };
    process.exit = (code) => { result.exits.push(code); };
    const cleanup = shutdownHandler({ logger: { info() {}, warn() {} }, stop: async () => { result.stopCalled = true; return { forced: false, pending: [] }; } });
    const force = process.listeners("SIGQUIT").find((listener) => listener.name === "sigquitHandler");
    force();
    cleanup();
    console.log(JSON.stringify(result));
  `;
  const subprocess = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
  });

  expect(subprocess.status).toBe(0);
  expect(JSON.parse(subprocess.stdout)).toEqual({
    exits: [1],
    stopCalled: false,
  });
});

/**
 * @case SIGBREAK forces an immediate exit during graceful shutdown
 * @preconditions SIGINT has started a pending graceful shutdown, then SIGBREAK arrives
 * @expectedResult SIGBREAK invokes exit code 1 without waiting for context.stop
 */
test("SIGBREAK forces immediate exit during graceful shutdown", () => {
  const source = new URL("../src/shutdown.ts", import.meta.url).href;
  const script = `
    const { shutdownHandler } = await import(${JSON.stringify(source)});
    const result = { stopStarted: false, forceHandled: false, exitCode: undefined };
    process.exit = (code) => { result.forceHandled = true; result.exitCode = code; };
    const context = { logger: { info() {}, warn() {} }, stop: () => { result.stopStarted = true; return new Promise(() => {}); } };
    const cleanup = shutdownHandler(context);
    const graceful = process.listeners("SIGINT").find((listener) => listener.name === "sigintHandler");
    const force = process.listeners("SIGBREAK").find((listener) => listener.name === "sigbreakHandler");
    graceful();
    force();
    cleanup();
    console.log(JSON.stringify(result));
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
  });

  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    stopStarted: true,
    forceHandled: true,
    exitCode: 1,
  });
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
  const cleanup = shutdownHandler(
    makeContext(async () => ({ forced: false, pending: [] })),
  );

  cleanup();

  for (const signal of before.keys()) {
    expect(process.listenerCount(signal)).toBe(before.get(signal)!);
  }
});
