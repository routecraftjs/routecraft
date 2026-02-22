import { describe, it, expect, vi, beforeEach } from "vitest";
import { testContext } from "@routecraft/testing";
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
    // Create a context with the route builder and run full lifecycle (t.logger is a spy)
    const t = await testContext().routes(enrichExample).build();

    await t.test();

    // Verify the result
    expect(t.logger.info).toHaveBeenCalled();

    // Find the LogAdapter output call (pino.info(object, message)); lifecycle also logs at info
    const infoSpy = t.logger.info as ReturnType<typeof vi.fn>;
    const logAdapterCall = infoSpy.mock.calls.find(
      (call: unknown[]) => call[1] === "LogAdapter output",
    );
    expect(logAdapterCall).toBeDefined();
    const result = logAdapterCall![0];

    expect(result).toBeDefined();
    expect(result.body).toHaveProperty("original");
    expect(result.body).toHaveProperty("additional");
    expect(result.body.original).toBe("Original message");
    expect(result.body.additional).toBe("Additional data");
  });
});
