import { assert } from "@std/assert";
import { spy } from "@std/testing/mock";
import { Exchange, HeadersKeys, OperationType } from "@routecraft/core";
import { context } from "@routecraft/dsl";
import routes from "./hello-world.ts";

Deno.test("Context loads", async () => {
  const consoleSpy = spy(console, "log");
  try {
    await context()
      .onStartup(() => {
        console.log("Startup");
      })
      .onShutdown(() => {
        console.log("Shutdown");
      })
      .routes(routes)
      .build()
      .start();

    // Get the actual calls, filtering out our debug messages
    const actualCalls = consoleSpy.calls
      .map((call) => call.args[0])
      .filter((msg) =>
        typeof msg === "string" && !msg.startsWith("Captured calls")
      );

    // Log filtered calls for debugging
    console.log(
      "Captured calls:",
      actualCalls,
    );

    // Verify startup and shutdown
    assert(actualCalls[0] === "Startup", "Missing startup log");
    assert(
      actualCalls[actualCalls.length - 1] === "Shutdown",
      "Missing shutdown log",
    );

    // Find all exchange-related logs
    const logCalls = consoleSpy.calls.filter((call) =>
      call.args[0] === "Logging Exchange"
    );
    const processingCall = consoleSpy.calls.find((call) =>
      call.args[0] === "Processing exchange"
    );

    assert(processingCall, "Should have a processing exchange log");
    assert(
      logCalls.length === 2,
      "Should have exactly 2 logging exchange calls",
    );

    // Get the exchange objects
    const firstLog = logCalls[0].args[1] as Exchange;
    const processingLog = processingCall.args[1] as Exchange;
    const secondLog = logCalls[1].args[1] as Exchange;

    // Verify exchange IDs are consistent
    assert(
      firstLog.id === processingLog.id && processingLog.id === secondLog.id,
      "All exchanges should have the same ID",
    );

    // Verify correlation IDs are consistent
    const correlationId = firstLog.headers[HeadersKeys.CORRELATION_ID];
    assert(correlationId, "Should have a correlation ID");
    assert(
      correlationId === processingLog.headers[HeadersKeys.CORRELATION_ID] &&
        correlationId === secondLog.headers[HeadersKeys.CORRELATION_ID],
      "All exchanges should have the same correlation ID",
    );

    // Verify operation types
    assert(
      processingLog.headers[HeadersKeys.OPERATION] === OperationType.PROCESS,
      "Processing exchange should have PROCESS operation type",
    );

    // Verify the bodies
    assert(
      firstLog.body === "Hello, World!",
      "First log should have original message",
    );
    assert(
      secondLog.body === "HELLO, WORLD!",
      "Second log should have uppercase message",
    );
  } finally {
    consoleSpy.restore();
  }
});
