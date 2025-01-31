import { expect, test, mock } from "bun:test";
import type { Exchange } from "@routecraft/core";
import { HeadersKeys, OperationType } from "@routecraft/core";
import { context } from "@routecraft/dsl";
import routes from "./hello-world.ts";

test("Context loads", async () => {
  const calls: Array<{ args: any[] }> = [];
  const originalConsoleInfo = console.info;
  console.info = mock((...args: any[]) => {
    calls.push({ args });
    originalConsoleInfo(...args);
  });

  try {
    await context()
      .onStartup(() => {
        console.info("Startup");
      })
      .onShutdown(() => {
        console.info("Shutdown");
      })
      .routes(routes)
      .build()
      .start();

    // Get the actual calls, filtering out our debug messages
    const actualCalls = calls
      .map((call) => call.args[0])
      .filter(
        (msg: unknown) =>
          typeof msg === "string" && !msg.startsWith("Captured calls"),
      );

    // Verify startup and shutdown
    expect(actualCalls[1]).toBe("Startup");
    expect(actualCalls[actualCalls.length - 2]).toBe("Shutdown");

    // Find all exchange-related logs
    const logCalls = calls.filter(
      (call) => call.args[0] === "Logging Exchange",
    );
    const processingCall = calls.find(
      (call) => call.args[0] === "Processing exchange",
    );

    expect(processingCall).toBeTruthy();
    expect(logCalls).toHaveLength(2);

    // Get the exchange objects
    const firstLog = logCalls[0].args[1] as Exchange;
    const processingLog = processingCall!.args[1] as Exchange;
    const secondLog = logCalls[1].args[1] as Exchange;

    // Verify exchange IDs are consistent
    expect(firstLog.id).toBe(processingLog.id);
    expect(processingLog.id).toBe(secondLog.id);

    // Verify correlation IDs are consistent
    const correlationId = firstLog.headers[HeadersKeys.CORRELATION_ID];
    expect(correlationId).toBeTruthy();
    if (typeof correlationId === "string") {
      expect(processingLog.headers[HeadersKeys.CORRELATION_ID]).toBe(
        correlationId,
      );
      expect(secondLog.headers[HeadersKeys.CORRELATION_ID]).toBe(correlationId);
    } else {
      throw new Error("Correlation ID must be a string");
    }

    // Verify operation types
    expect(processingLog.headers[HeadersKeys.OPERATION]).toBe(
      OperationType.PROCESS,
    );

    // Verify the bodies
    expect(firstLog.body).toBe("Hello, World!");
    expect(secondLog.body).toBe("HELLO, WORLD!");
  } finally {
    console.info = originalConsoleInfo;
  }
});
