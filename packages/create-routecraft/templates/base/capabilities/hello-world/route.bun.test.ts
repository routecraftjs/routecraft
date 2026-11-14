import { describe, test, expect, mock, afterEach } from "bun:test";
import { http } from "@routecraft/routecraft";
import { mcp } from "@routecraft/ai";
import {
  mockAdapter,
  testContext,
  type TestContext,
} from "@routecraft/testing";
import capabilities from "./route.js";

describe("Hello World Routes", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) {
      await t.stop();
    }
  });

  /**
   * @case Verifies that the simple route dispatches to the direct "greet" route, which looks the user up and greets them by name
   * @preconditions Both routes are registered, the mcp() source is mocked so no MCP transport starts, and the http() lookup is mocked to return a JSON Placeholder user
   * @expectedResult greet calls the http() lookup once with userId 1 and logs "Hello, [name]!" as its last step
   */
  test("dispatches from simple route into direct route and greets by name", async () => {
    const httpMock = mockAdapter(http, {
      send: async () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: { id: 1, name: "Leanne Graham" },
        url: "https://jsonplaceholder.typicode.com/users/1",
      }),
    });

    t = await testContext({ fn: mock })
      .override(mockAdapter(mcp, { source: [] }))
      .override(httpMock)
      .routes(capabilities)
      .build();
    await t.test();

    expect(httpMock.calls.send).toHaveLength(1);
    expect(httpMock.calls.send[0].exchange.body).toEqual({ userId: 1 });

    const infoSpy = t.logger.info as ReturnType<typeof mock>;
    const greeting = infoSpy.mock.calls.find(
      (call: unknown[]) => call[1] === "Greeting built",
    );
    expect(greeting).toBeDefined();
    expect((greeting![0] as { greeting: string }).greeting).toBe(
      "Hello, Leanne Graham!",
    );
  });
});
