import { describe, it, expect, vi, beforeEach } from "vitest";
import { context } from "@routecraftjs/routecraft";
import enrichExample from "./enrich-example.mjs";

describe("Enrich Example", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * @case Tests that the enrich example correctly adds additional data to the original exchange
   * @preconditions A route with an enrich operation that adds additional data
   * @expectedResult The exchange body should contain both original and additional data
   */
  it("should enrich an exchange with additional data", async () => {
    // Create a context with the route builder
    const ctx = context().routes(enrichExample).build();

    // Spy on console.log to capture the output
    const logSpy = vi.spyOn(console, "log");

    // Start the context
    await ctx.start();

    // Wait for the exchange to be processed
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Stop the context
    await ctx.stop();

    // Verify the result
    expect(logSpy).toHaveBeenCalled();

    // Get the last call arguments (the enriched exchange)
    const result = logSpy.mock.calls[logSpy.mock.calls.length - 1][0];

    expect(result).toBeDefined();
    expect(result.body).toHaveProperty("original");
    expect(result.body).toHaveProperty("additional");
    expect(result.body.original).toBe("Original message");
    expect(result.body.additional).toBe("Additional data");
  });
});
