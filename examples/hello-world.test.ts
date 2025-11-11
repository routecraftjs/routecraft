import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { context, type CraftContext, logger } from "@routecraft/routecraft";
import routes from "./hello-world.mjs";

describe("Hello World Route", () => {
  let testContext: CraftContext;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Mock globalThis.fetch to prevent real API calls
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(async () => {
    if (testContext) {
      await testContext.stop();
    }
    vi.restoreAllMocks();
  });

  /**
   * @case Verifies that the route fetches user data and greets the person by name
   * @preconditions Route is imported and fetch is mocked
   * @expectedResult Route should fetch user and output "Hello, [name]!"
   */
  it("should fetch user and greet by name", async () => {
    // Mock user data from JSON Placeholder
    const mockUser = {
      id: 1,
      name: "Leanne Graham",
      username: "Bret",
      email: "Sincere@april.biz",
    };

    // Mock the fetch response
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      text: async () => JSON.stringify(mockUser),
      url: "https://jsonplaceholder.typicode.com/users/1",
    });

    // Spy on logger.info to capture the output
    const logSpy = vi.spyOn(logger, "info");

    // Create context with imported route
    testContext = context().routes(routes).build();

    // Start the context
    await testContext.start();

    // Wait for the exchange to be processed
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Stop the context
    await testContext.stop();

    // Verify fetch was called with the correct URL
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://jsonplaceholder.typicode.com/users/1",
      expect.objectContaining({
        method: "GET",
      }),
    );

    // Verify the log was called (route completed)
    expect(logSpy).toHaveBeenCalled();

    // Get the last call arguments (the logged data and message)
    // pino.info() is called with (object, message) format
    const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1];
    const result = lastCall[0]; // First argument is the logged object

    // Assert the greeting message
    expect(result).toBeDefined();
    expect(result.body).toBe("Hello, Leanne Graham!");
  });
});
