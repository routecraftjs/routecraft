import { assert } from "@std/assert";
import { spy } from "@std/testing/mock";
import { Exchange } from "@routecraft/core";
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
      .run();

    // Verify startup and shutdown
    assert(consoleSpy.calls[0].args[0] === "Startup");
    assert(
      consoleSpy.calls[consoleSpy.calls.length - 1].args[0] === "Shutdown",
    );

    // Find the logging exchange calls
    const logCalls = consoleSpy.calls.filter((call) =>
      call.args[0] === "Logging Exchange"
    );
    assert(
      logCalls.length === 2,
      "Should have exactly 2 logging exchange calls",
    );

    // Get the exchange objects directly from the second argument
    const firstLog = logCalls[0].args[1] as Exchange;
    const secondLog = logCalls[1].args[1] as Exchange;

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
