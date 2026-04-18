import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testContext, type TestContext } from "@routecraft/testing";
import routes from "../src/hello-world";

describe("Hello World Routes", () => {
  let t: TestContext;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Mock globalThis.fetch to prevent real API calls
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(async () => {
    if (t) {
      await t.stop();
    }
    vi.restoreAllMocks();
  });

  /**
   * @case Verifies that the simple route dispatches to the direct "greet" route, which fetches and greets the user by name
   * @preconditions Both routes are registered and fetch is mocked
   * @expectedResult greet route fetches the user and logs "Hello, [name]!"
   */
  it("dispatches from simple route into direct route and greets by name", async () => {
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

    // Create context with both routes and run full lifecycle (t.logger is a spy)
    t = await testContext().routes(routes).build();
    await t.test();

    // Verify fetch was called with the correct URL
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://jsonplaceholder.typicode.com/users/1",
      expect.objectContaining({
        method: "GET",
      }),
    );

    // Verify the log was called (route completed)
    expect(t.logger.info).toHaveBeenCalled();

    // Find the LogAdapter output call (pino.info(object, message)); lifecycle also logs at info
    const infoSpy = t.logger.info as ReturnType<typeof vi.fn>;
    const logAdapterCall = infoSpy.mock.calls.find(
      (call: unknown[]) => call[1] === "LogAdapter output",
    );
    expect(logAdapterCall).toBeDefined();
    const result = logAdapterCall![0];

    // Assert the greeting message
    expect(result).toBeDefined();
    expect(result.body).toBe("Hello, Leanne Graham!");
  });
});
