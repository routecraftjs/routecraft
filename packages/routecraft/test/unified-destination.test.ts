import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  context,
  craft,
  simple,
  fetch,
  log,
  type CraftContext,
  type Destination,
} from "@routecraft/routecraft";

describe("Unified Destination Adapter", () => {
  let testContext: CraftContext;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Mock globalThis.fetch
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
   * @case Verify .to() with void-returning adapter (log)
   * @preconditions Adapter returns void
   * @expectedResult Body unchanged, log called
   */
  test(".to() with void-returning adapter ignores result", async () => {
    const destSpy = vi.fn();

    testContext = context()
      .routes(
        craft()
          .id("test-void-adapter")
          .from(simple({ userId: 1, name: "John" }))
          .to(log())
          .to(destSpy),
      )
      .build();

    await testContext.start();

    expect(destSpy).toHaveBeenCalledTimes(1);
    const finalBody = destSpy.mock.calls[0][0].body;
    expect(finalBody).toEqual({ userId: 1, name: "John" });
  });

  /**
   * @case Verify .to() with result-returning adapter replaces body
   * @preconditions fetch returns result
   * @expectedResult Body replaced with FetchResult
   */
  test(".to() with result-returning adapter replaces body", async () => {
    const destSpy = vi.fn();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      text: async () => JSON.stringify({ apiData: "value" }),
      url: "https://api.example.com/endpoint",
    });

    testContext = context()
      .routes(
        craft()
          .id("test-default-to")
          .from(simple({ original: "data" }))
          .to(fetch({ url: "https://api.example.com/endpoint" }))
          .to(destSpy),
      )
      .build();

    await testContext.start();

    expect(destSpy).toHaveBeenCalledTimes(1);
    const finalBody = destSpy.mock.calls[0][0].body;
    // Body should be replaced with FetchResult
    expect(finalBody.status).toBe(200);
    expect(finalBody.body).toEqual({ apiData: "value" });
  });

  /**
   * @case Verify .to() chains with body transformation
   * @preconditions Multiple .to() calls where some return data
   * @expectedResult Each .to() that returns data replaces the body
   */
  test(".to() chains with body transformation", async () => {
    const destSpy = vi.fn();

    testContext = context()
      .routes(
        craft()
          .id("test-to-chain")
          .from(simple({ step: 0 }))
          .to(async (ex) => ({ ...ex.body, step: 1 }))
          .to(async (ex) => ({ ...ex.body, step: 2 }))
          .to(destSpy),
      )
      .build();

    await testContext.start();

    expect(destSpy).toHaveBeenCalledTimes(1);
    const finalBody = destSpy.mock.calls[0][0].body;
    expect(finalBody).toEqual({
      step: 2,
    });
  });

  /**
   * @case Verify .enrich() with default aggregator merges result
   * @preconditions fetch returns result, no custom aggregator
   * @expectedResult Result merged into body
   */
  test(".enrich() with result-returning adapter merges by default", async () => {
    const destSpy = vi.fn();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      text: async () => JSON.stringify({ profile: "data", avatar: "url" }),
      url: "https://api.example.com/profile",
    });

    testContext = context()
      .routes(
        craft()
          .id("test-default-enrich")
          .from(simple({ userId: 1 }))
          .enrich(fetch({ url: "https://api.example.com/profile" }))
          .to(destSpy),
      )
      .build();

    await testContext.start();

    expect(destSpy).toHaveBeenCalledTimes(1);
    const finalBody = destSpy.mock.calls[0][0].body;
    // FetchResult is merged into body
    expect(finalBody).toMatchObject({
      userId: 1,
      body: { profile: "data", avatar: "url" },
      status: 200,
    });
  });

  /**
   * @case Verify .enrich() with custom aggregator
   * @preconditions fetch returns result, custom aggregator provided
   * @expectedResult Result merged via custom logic
   */
  test(".enrich() with custom aggregator uses custom logic", async () => {
    const destSpy = vi.fn();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      text: async () => JSON.stringify({ name: "John", role: "Admin" }),
      url: "https://api.example.com/user",
    });

    testContext = context()
      .routes(
        craft()
          .id("test-custom-enrich-aggregator")
          .from(simple({ userId: 1 }))
          .enrich(
            fetch({ url: "https://api.example.com/user" }),
            (original, result) => ({
              ...original,
              body: {
                ...original.body,
                userDetails: result.body,
              },
            }),
          )
          .to(destSpy),
      )
      .build();

    await testContext.start();

    expect(destSpy).toHaveBeenCalledTimes(1);
    const finalBody = destSpy.mock.calls[0][0].body;
    expect(finalBody).toEqual({
      userId: 1,
      userDetails: { name: "John", role: "Admin" },
    });
  });

  /**
   * @case Verify multiple .to() calls with body replacement
   * @preconditions Multiple .to() calls with result-returning adapters
   * @expectedResult Last result-returning .to() determines body
   */
  test("multiple .to() calls replace body sequentially", async () => {
    const destSpy = vi.fn();

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([["content-type", "application/json"]]),
        text: async () => JSON.stringify({ response: "data1" }),
        url: "https://api.example.com/endpoint1",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([["content-type", "application/json"]]),
        text: async () => JSON.stringify({ response: "data2" }),
        url: "https://api.example.com/endpoint2",
      });

    testContext = context()
      .routes(
        craft()
          .id("test-multiple-to")
          .from(simple({ original: "value" }))
          .to(fetch({ url: "https://api.example.com/endpoint1" }))
          .to(fetch({ url: "https://api.example.com/endpoint2" }))
          .to(destSpy),
      )
      .build();

    await testContext.start();

    expect(destSpy).toHaveBeenCalledTimes(1);
    const finalBody = destSpy.mock.calls[0][0].body;
    // Body should be the last FetchResult
    expect(finalBody).toMatchObject({
      status: 200,
      body: { response: "data2" },
    });
  });

  /**
   * @case Verify mix of .to() and .enrich() calls
   * @preconditions Mix of .to() and .enrich() operations
   * @expectedResult .to() replaces body, .enrich() merges
   */
  test("mixing .to() and .enrich() works correctly", async () => {
    const destSpy = vi.fn();

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([["content-type", "application/json"]]),
        text: async () => JSON.stringify({ name: "John" }),
        url: "https://api.example.com/user",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([["content-type", "application/json"]]),
        text: async () => JSON.stringify({ webhookData: "data" }),
        url: "https://api.example.com/webhook",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([["content-type", "application/json"]]),
        text: async () => JSON.stringify({ role: "Admin" }),
        url: "https://api.example.com/role",
      });

    testContext = context()
      .routes(
        craft()
          .id("test-mixed-operations")
          .from(simple({ userId: 1 }))
          .enrich(fetch({ url: "https://api.example.com/user" })) // Merges
          .to(fetch({ url: "https://api.example.com/webhook" })) // Replaces body
          .enrich(fetch({ url: "https://api.example.com/role" })) // Merges
          .to(destSpy),
      )
      .build();

    await testContext.start();

    expect(destSpy).toHaveBeenCalledTimes(1);
    const finalBody = destSpy.mock.calls[0][0].body;
    // Body flow: start with userId -> enrich merges user data -> .to() replaces with webhook result -> enrich merges role
    expect(finalBody).toMatchObject({
      body: { role: "Admin" },
      status: 200,
    });
  });

  /**
   * @case Verify .enrich() handles undefined result gracefully
   * @preconditions Adapter returns undefined
   * @expectedResult Body unchanged
   */
  test(".enrich() with undefined result returns original", async () => {
    const destSpy = vi.fn();
    const undefinedAdapter: Destination<any, void> = {
      async send() {
        return undefined;
      },
    };

    testContext = context()
      .routes(
        craft()
          .id("test-undefined-enrich")
          .from(simple({ original: "data" }))
          .enrich(undefinedAdapter)
          .to(destSpy),
      )
      .build();

    await testContext.start();

    expect(destSpy).toHaveBeenCalledTimes(1);
    const finalBody = destSpy.mock.calls[0][0].body;
    // Body should be unchanged when enrich returns undefined
    expect(finalBody).toEqual({ original: "data" });
  });

  /**
   * @case Verify .enrich() handles null result gracefully
   * @preconditions Adapter returns null
   * @expectedResult Body unchanged
   */
  test(".enrich() with null result returns original", async () => {
    const destSpy = vi.fn();
    const nullAdapter: Destination<any, null> = {
      async send() {
        return null;
      },
    };

    testContext = context()
      .routes(
        craft()
          .id("test-null-enrich")
          .from(simple({ original: "data" }))
          .enrich(nullAdapter)
          .to(destSpy),
      )
      .build();

    await testContext.start();

    expect(destSpy).toHaveBeenCalledTimes(1);
    const finalBody = destSpy.mock.calls[0][0].body;
    // Body should be unchanged when enrich returns null
    expect(finalBody).toEqual({ original: "data" });
  });

  /**
   * @case Verify callable destination works with .to()
   * @preconditions Using function instead of adapter object
   * @expectedResult Function called, body replaced with result
   */
  test(".to() with callable destination function", async () => {
    const callableSpy = vi.fn(async () => ({ result: "replaced" }));
    const destSpy = vi.fn();

    testContext = context()
      .routes(
        craft()
          .id("test-callable-to")
          .from(simple({ data: "value" }))
          .to(callableSpy)
          .to(destSpy),
      )
      .build();

    await testContext.start();

    expect(callableSpy).toHaveBeenCalledTimes(1);
    expect(destSpy).toHaveBeenCalledTimes(1);
    const finalBody = destSpy.mock.calls[0][0].body;
    expect(finalBody).toEqual({ result: "replaced" });
  });

  /**
   * @case Verify callable destination works with .enrich()
   * @preconditions Using function instead of adapter object
   * @expectedResult Function called, result merged
   */
  test(".enrich() with callable destination function", async () => {
    const callableEnricher = vi.fn(async () => ({ enriched: "data" }));
    const destSpy = vi.fn();

    testContext = context()
      .routes(
        craft()
          .id("test-callable-enrich")
          .from(simple({ original: "value" }))
          .enrich(callableEnricher)
          .to(destSpy),
      )
      .build();

    await testContext.start();

    expect(callableEnricher).toHaveBeenCalledTimes(1);
    expect(destSpy).toHaveBeenCalledTimes(1);
    const finalBody = destSpy.mock.calls[0][0].body;
    expect(finalBody).toEqual({ original: "value", enriched: "data" });
  });
});
