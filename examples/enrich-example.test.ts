import { describe, it, expect, vi, beforeEach } from "vitest";
import { testContext, logger } from "@routecraft/routecraft";
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
    // Mock logger.child so createLogger() returns this mock; routes use context.logger from createLogger
    const infoSpy = vi.fn();
    const mockLogger = {
      info: infoSpy,
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    };
    vi.spyOn(logger, "child").mockReturnValue(mockLogger as any);

    // Create a context with the route builder and run full lifecycle
    const t = await testContext().routes(enrichExample).build();

    await t.test();

    // Verify the result
    expect(infoSpy).toHaveBeenCalled();

    // Get the last call arguments (the logged data)
    // pino.info() is called with (object, message) format
    const lastCall = infoSpy.mock.calls[infoSpy.mock.calls.length - 1];
    const result = lastCall[0]; // First argument is the logged object

    expect(result).toBeDefined();
    expect(result.body).toHaveProperty("original");
    expect(result.body).toHaveProperty("additional");
    expect(result.body.original).toBe("Original message");
    expect(result.body.additional).toBe("Additional data");
  });
});
