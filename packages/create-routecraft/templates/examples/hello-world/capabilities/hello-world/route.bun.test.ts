import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import capabilities from "./route.js";

describe("Hello World Routes", () => {
  let t: TestContext;
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    fetchMock = mock();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(async () => {
    if (t) {
      await t.stop();
    }
  });

  /**
   * @case Verifies that the simple route dispatches to the direct "greet" route, which fetches and greets the user by name
   * @preconditions Both routes are registered and fetch is mocked to return a JSON Placeholder user
   * @expectedResult greet route fetches the user and logs "Hello, [name]!" via the LogAdapter
   */
  test("dispatches from simple route into direct route and greets by name", async () => {
    const mockUser = {
      id: 1,
      name: "Leanne Graham",
      username: "Bret",
      email: "Sincere@april.biz",
    };

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      text: async () => JSON.stringify(mockUser),
      url: "https://jsonplaceholder.typicode.com/users/1",
    });

    t = await testContext().routes(capabilities).build();
    await t.test();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://jsonplaceholder.typicode.com/users/1",
      expect.objectContaining({
        method: "GET",
      }),
    );

    expect(t.logger.info).toHaveBeenCalled();

    const infoSpy = t.logger.info as ReturnType<typeof mock>;
    const logAdapterCall = infoSpy.mock.calls.find(
      (call: unknown[]) => call[1] === "LogAdapter output",
    );
    expect(logAdapterCall).toBeDefined();
    const result = logAdapterCall![0];

    expect(result).toBeDefined();
    expect(result.body).toBe("Hello, Leanne Graham!");
  });
});
