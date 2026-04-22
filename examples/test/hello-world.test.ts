import { describe, it, expect, afterEach, vi } from "vitest";
import { http } from "@routecraft/routecraft";
import {
  mockAdapter,
  testContext,
  type TestContext,
} from "@routecraft/testing";
import routes from "../src/hello-world";

describe("Hello World Routes", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) {
      await t.stop();
    }
    vi.restoreAllMocks();
  });

  /**
   * @case simple route dispatches into the direct("greet") route, whose http enrich lookup is mocked at the adapter boundary
   * @preconditions Both routes registered; mockAdapter(http, ...) stands in for the real fetch
   * @expectedResult Greet route logs "Hello, [name]!" and the http mock received the expected URL
   */
  it("dispatches from simple route into direct route and greets by name", async () => {
    const httpMock = mockAdapter(http, {
      send: async () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: { id: 1, name: "Leanne Graham", username: "Bret" },
        url: "https://jsonplaceholder.typicode.com/users/1",
      }),
    });

    t = await testContext().override(httpMock).routes(routes).build();
    await t.test();

    // The http adapter was invoked exactly once, at the .enrich() call site in
    // the greet route. The recorded args are whatever was passed to http(...)
    // in hello-world.ts; we use them to assert the url the real adapter would
    // have fetched.
    expect(httpMock.calls.send).toHaveLength(1);

    const [call] = httpMock.calls.send;
    const options = call.args[0] as {
      method: string;
      url: (ex: { body: { userId: number } }) => string;
    };
    expect(options.method).toBe("GET");
    expect(options.url({ body: { userId: 1 } })).toBe(
      "https://jsonplaceholder.typicode.com/users/1",
    );

    // The route's LogAdapter logs the greeting as the final step.
    const infoSpy = t.logger.info as ReturnType<typeof vi.fn>;
    const logAdapterCall = infoSpy.mock.calls.find(
      (c: unknown[]) => c[1] === "LogAdapter output",
    );
    expect(logAdapterCall).toBeDefined();
    expect(logAdapterCall![0].body).toBe("Hello, Leanne Graham!");
  });
});
