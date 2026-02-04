import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  context,
  craft,
  simple,
  fetch,
  log,
  noop,
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
   * @case Verify .to() with result-returning adapter uses default aggregator
   * @preconditions fetch returns result, no custom aggregator
   * @expectedResult Result ignored, body unchanged
   */
  test(".to() with result-returning adapter ignores result by default", async () => {
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
    // Body should be unchanged - fetch result ignored
    expect(finalBody).toEqual({ original: "data" });
  });

  /**
   * @case Verify .to() with custom aggregator captures result
   * @preconditions fetch returns result, custom aggregator provided
   * @expectedResult Result merged into body via aggregator
   */
  test(".to() with custom aggregator captures result", async () => {
    const destSpy = vi.fn();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      headers: new Map([["content-type", "application/json"]]),
      text: async () => JSON.stringify({ id: 123 }),
      url: "https://api.example.com/save",
    });

    testContext = context()
      .routes(
        craft()
          .id("test-custom-to-aggregator")
          .from(simple({ name: "John", email: "john@example.com" }))
          .to(
            fetch({ method: "POST", url: "https://api.example.com/save" }),
            (original, result) => ({
              ...original,
              body: {
                ...original.body,
                httpStatus: result.status,
                savedId: result.body.id,
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
      name: "John",
      email: "john@example.com",
      httpStatus: 201,
      savedId: 123,
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
   * @case Verify multiple .to() calls don't overwrite each other
   * @preconditions Multiple .to() calls with result-returning adapters
   * @expectedResult Body unchanged through all .to() operations
   */
  test("multiple .to() calls maintain body", async () => {
    const destSpy = vi.fn();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      text: async () => JSON.stringify({ response: "data" }),
      url: "https://api.example.com/endpoint",
    });

    testContext = context()
      .routes(
        craft()
          .id("test-multiple-to")
          .from(simple({ original: "value" }))
          .to(fetch({ url: "https://api.example.com/endpoint1" }))
          .to(fetch({ url: "https://api.example.com/endpoint2" }))
          .to(noop())
          .to(destSpy),
      )
      .build();

    await testContext.start();

    expect(destSpy).toHaveBeenCalledTimes(1);
    const finalBody = destSpy.mock.calls[0][0].body;
    // Body should be unchanged through all .to() calls
    expect(finalBody).toEqual({ original: "value" });
  });

  /**
   * @case Verify mix of .to() and .enrich() calls
   * @preconditions Mix of .to() and .enrich() operations
   * @expectedResult .to() preserves body, .enrich() adds to it
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
        text: async () => JSON.stringify({ ignored: "data" }),
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
          .to(fetch({ url: "https://api.example.com/webhook" })) // Ignored
          .enrich(fetch({ url: "https://api.example.com/role" })) // Merges
          .to(destSpy),
      )
      .build();

    await testContext.start();

    expect(destSpy).toHaveBeenCalledTimes(1);
    const finalBody = destSpy.mock.calls[0][0].body;
    // Should have userId + first enrich + second enrich (webhook ignored)
    expect(finalBody).toMatchObject({
      userId: 1,
      body: { role: "Admin" }, // Last enrich
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
   * @expectedResult Function called, body unchanged
   */
  test(".to() with callable destination function", async () => {
    const callableSpy = vi.fn(async () => ({ result: "ignored" }));
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
    expect(finalBody).toEqual({ data: "value" });
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
