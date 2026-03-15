import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import {
  craft,
  simple,
  http,
  log,
  only,
  type Destination,
} from "@routecraft/routecraft";

// Use t.test() for normal runs (start → wait routes ready → drain → stop). Use t.ctx.start() when a route does not emit routeStarted (e.g. dynamic source) or when you need manual lifecycle control.
describe("Unified Destination Adapter", () => {
  let t: TestContext;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Mock globalThis.fetch
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
   * @case Verify .to() with void-returning adapter (log)
   * @preconditions Adapter returns void
   * @expectedResult Body unchanged, log called
   */
  test(".to() with void-returning adapter ignores result", async () => {
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("test-void-adapter")
          .from(simple({ userId: 1, name: "John" }))
          .to(log())
          .to(s),
      )
      .build();

    await t.test();

    expect(s.received).toHaveLength(1);
    expect(s.received[0].body).toEqual({ userId: 1, name: "John" });
  });

  /**
   * @case Verify .to() with result-returning adapter replaces body
   * @preconditions http returns result
   * @expectedResult Body replaced with HttpResult
   */
  test(".to() with result-returning adapter replaces body", async () => {
    const s = spy();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      text: async () => JSON.stringify({ apiData: "value" }),
      url: "https://api.example.com/endpoint",
    });

    t = await testContext()
      .routes(
        craft()
          .id("test-default-to")
          .from(simple({ original: "data" }))
          .to(http({ url: "https://api.example.com/endpoint" }))
          .to(s),
      )
      .build();

    await t.test();

    expect(s.received).toHaveLength(1);
    const finalBody = s.received[0].body;
    // Body should be replaced with HttpResult
    expect(finalBody.status).toBe(200);
    expect(finalBody.body).toEqual({ apiData: "value" });
  });

  /**
   * @case Verify .to() chains with body transformation
   * @preconditions Multiple .to() calls where some return data
   * @expectedResult Each .to() that returns data replaces the body
   */
  test(".to() chains with body transformation", async () => {
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("test-to-chain")
          .from(simple({ step: 0 }))
          .to(async (ex) => ({ ...ex.body, step: 1 }))
          .to(async (ex) => ({ ...ex.body, step: 2 }))
          .to(s),
      )
      .build();

    await t.test();

    expect(s.received).toHaveLength(1);
    expect(s.received[0].body).toEqual({
      step: 2,
    });
  });

  /**
   * @case Verify .enrich() with default aggregator merges result
   * @preconditions http returns result, no custom aggregator
   * @expectedResult Result merged into body
   */
  test(".enrich() with result-returning adapter merges by default", async () => {
    const s = spy();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      text: async () => JSON.stringify({ profile: "data", avatar: "url" }),
      url: "https://api.example.com/profile",
    });

    t = await testContext()
      .routes(
        craft()
          .id("test-default-enrich")
          .from(simple({ userId: 1 }))
          .enrich(http({ url: "https://api.example.com/profile" }))
          .to(s),
      )
      .build();

    await t.test();

    expect(s.received).toHaveLength(1);
    const finalBody = s.received[0].body;
    // HttpResult is merged into body
    expect(finalBody).toMatchObject({
      userId: 1,
      body: { profile: "data", avatar: "url" },
      status: 200,
    });
  });

  /**
   * @case Verify .enrich() with custom aggregator
   * @preconditions http returns result, custom aggregator provided
   * @expectedResult Result merged via custom logic
   */
  test(".enrich() with custom aggregator uses custom logic", async () => {
    const s = spy();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      text: async () => JSON.stringify({ name: "John", role: "Admin" }),
      url: "https://api.example.com/user",
    });

    t = await testContext()
      .routes(
        craft()
          .id("test-custom-enrich-aggregator")
          .from(simple({ userId: 1 }))
          .enrich(
            http({ url: "https://api.example.com/user" }),
            (original, result) => ({
              ...original,
              body: {
                ...original.body,
                userDetails: result.body,
              },
            }),
          )
          .to(s),
      )
      .build();

    await t.test();

    expect(s.received).toHaveLength(1);
    expect(s.received[0].body).toEqual({
      userId: 1,
      userDetails: { name: "John", role: "Admin" },
    });
  });

  /**
   * @case Verify .enrich() with only() and into sets single key
   * @preconditions Enricher returns object with output.links, only(getValue, "links") used
   * @expectedResult Body has links key set to extracted value
   */
  test(".enrich() with only(getValue, into) sets body key", async () => {
    const s = spy();
    const enricher = vi.fn(async () => ({ output: { links: ["a", "b"] } }));

    t = await testContext()
      .routes(
        craft()
          .id("test-only-with-into")
          .from(simple({ userId: 1 }))
          .enrich(
            enricher,
            only((r) => r.output?.links, "links"),
          )
          .to(s),
      )
      .build();

    await t.test();

    expect(s.received).toHaveLength(1);
    expect(s.received[0].body).toEqual({
      userId: 1,
      links: ["a", "b"],
    });
  });

  /**
   * @case Verify .enrich() with only() without into spreads plain object
   * @preconditions Enricher returns plain object, only(getValue) used without into
   * @expectedResult Body gets spread with object keys
   */
  test(".enrich() with only(getValue) spreads plain object onto body", async () => {
    const s = spy();
    const enricher = vi.fn(async () => ({
      output: { links: ["x"], count: 1 },
    }));

    t = await testContext()
      .routes(
        craft()
          .id("test-only-spread-object")
          .from(simple({ userId: 1 }))
          .enrich(
            enricher,
            only((r) => r.output),
          )
          .to(s),
      )
      .build();

    await t.test();

    expect(s.received).toHaveLength(1);
    expect(s.received[0].body).toEqual({
      userId: 1,
      links: ["x"],
      count: 1,
    });
  });

  /**
   * @case Verify .enrich() with only() without into puts string in body.stdout
   * @preconditions Enricher returns string, only(getValue) used without into
   * @expectedResult Body has stdout key set to string
   */
  test(".enrich() with only(getValue) puts string in body.stdout", async () => {
    const s = spy();
    const enricher = vi.fn(async () => "hello");

    t = await testContext()
      .routes(
        craft()
          .id("test-only-string-stdout")
          .from(simple({ userId: 1 }))
          .enrich(
            enricher,
            only((r) => r),
          )
          .to(s),
      )
      .build();

    await t.test();

    expect(s.received).toHaveLength(1);
    expect(s.received[0].body).toEqual({
      userId: 1,
      stdout: "hello",
    });
  });

  /**
   * @case Verify .enrich() with only() without into puts array in body.array
   * @preconditions Enricher returns array, only(getValue) used without into
   * @expectedResult Body has array key set to array value
   */
  test(".enrich() with only(getValue) puts array in body.array", async () => {
    const s = spy();
    const enricher = vi.fn(async () => [1, 2, 3]);

    t = await testContext()
      .routes(
        craft()
          .id("test-only-array")
          .from(simple({ userId: 1 }))
          .enrich(
            enricher,
            only((r) => r),
          )
          .to(s),
      )
      .build();

    await t.test();

    expect(s.received).toHaveLength(1);
    expect(s.received[0].body).toEqual({
      userId: 1,
      array: [1, 2, 3],
    });
  });

  /**
   * @case Verify .enrich() with only() leaves exchange unchanged when getValue returns null/undefined
   * @preconditions Enricher returns object with output null or undefined, only(getValue) used
   * @expectedResult Body unchanged (no merge)
   */
  test(".enrich() with only() leaves body unchanged when value is null or undefined", async () => {
    const s = spy();
    const enricherNull = vi.fn(async () => ({ output: null }));
    const enricherUndef = vi.fn(async () => ({ output: undefined }));

    t = await testContext()
      .routes(
        craft()
          .id("test-only-null")
          .from(simple({ userId: 1 }))
          .enrich(
            enricherNull,
            only((r) => r.output),
          )
          .to(s),
      )
      .build();

    await t.test();
    expect(s.received[0].body).toEqual({ userId: 1 });

    await t.stop();

    const s2 = spy();
    t = await testContext()
      .routes(
        craft()
          .id("test-only-undefined")
          .from(simple({ userId: 1 }))
          .enrich(
            enricherUndef,
            only((r) => r.output),
          )
          .to(s2),
      )
      .build();

    await t.test();
    expect(s2.received[0].body).toEqual({ userId: 1 });
  });

  /**
   * @case Verify .enrich() with only() and optional chain returns undefined leaves body unchanged
   * @preconditions Enricher returns empty object, only((r) => r.output?.links) used
   * @expectedResult Body unchanged (optional chain yields undefined)
   */
  test(".enrich() with only() optional chain missing path leaves body unchanged", async () => {
    const s = spy();
    const enricher = vi.fn(async () => ({}));

    t = await testContext()
      .routes(
        craft()
          .id("test-only-optional-chain")
          .from(simple({ userId: 1 }))
          .enrich(
            enricher,
            only((r) => r.output?.links),
          )
          .to(s),
      )
      .build();

    await t.test();

    expect(s.received).toHaveLength(1);
    expect(s.received[0].body).toEqual({ userId: 1 });
  });

  /**
   * @case Verify multiple .to() calls with body replacement
   * @preconditions Multiple .to() calls with result-returning adapters
   * @expectedResult Last result-returning .to() determines body
   */
  test("multiple .to() calls replace body sequentially", async () => {
    const s = spy();

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

    t = await testContext()
      .routes(
        craft()
          .id("test-multiple-to")
          .from(simple({ original: "value" }))
          .to(http({ url: "https://api.example.com/endpoint1" }))
          .to(http({ url: "https://api.example.com/endpoint2" }))
          .to(s),
      )
      .build();

    await t.test();

    expect(s.received).toHaveLength(1);
    const finalBody = s.received[0].body;
    // Body should be the last HttpResult
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
    const s = spy();

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

    t = await testContext()
      .routes(
        craft()
          .id("test-mixed-operations")
          .from(simple({ userId: 1 }))
          .enrich(http({ url: "https://api.example.com/user" })) // Merges
          .to(http({ url: "https://api.example.com/webhook" })) // Replaces body
          .enrich(http({ url: "https://api.example.com/role" })) // Merges
          .to(s),
      )
      .build();

    await t.test();

    expect(s.received).toHaveLength(1);
    const finalBody = s.received[0].body;
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
    const s = spy();
    const undefinedAdapter: Destination<any, void> = {
      async send() {
        return undefined;
      },
    };

    t = await testContext()
      .routes(
        craft()
          .id("test-undefined-enrich")
          .from(simple({ original: "data" }))
          .enrich(undefinedAdapter)
          .to(s),
      )
      .build();

    await t.test();

    expect(s.received).toHaveLength(1);
    // Body should be unchanged when enrich returns undefined
    expect(s.received[0].body).toEqual({ original: "data" });
  });

  /**
   * @case Verify .enrich() handles null result gracefully
   * @preconditions Adapter returns null
   * @expectedResult Body unchanged
   */
  test(".enrich() with null result returns original", async () => {
    const s = spy();
    const nullAdapter: Destination<any, null> = {
      async send() {
        return null;
      },
    };

    t = await testContext()
      .routes(
        craft()
          .id("test-null-enrich")
          .from(simple({ original: "data" }))
          .enrich(nullAdapter)
          .to(s),
      )
      .build();

    await t.test();

    expect(s.received).toHaveLength(1);
    // Body should be unchanged when enrich returns null
    expect(s.received[0].body).toEqual({ original: "data" });
  });

  /**
   * @case Verify callable destination works with .to()
   * @preconditions Using function instead of adapter object
   * @expectedResult Function called, body replaced with result
   */
  test(".to() with callable destination function", async () => {
    const callableSpy = vi.fn(async () => ({ result: "replaced" }));
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("test-callable-to")
          .from(simple({ data: "value" }))
          .to(callableSpy)
          .to(s),
      )
      .build();

    await t.test();

    expect(callableSpy).toHaveBeenCalledTimes(1);
    expect(s.received).toHaveLength(1);
    expect(s.received[0].body).toEqual({ result: "replaced" });
  });

  /**
   * @case Verify callable destination works with .enrich()
   * @preconditions Using function instead of adapter object
   * @expectedResult Function called, result merged
   */
  test(".enrich() with callable destination function", async () => {
    const callableEnricher = vi.fn(async () => ({ enriched: "data" }));
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("test-callable-enrich")
          .from(simple({ original: "value" }))
          .enrich(callableEnricher)
          .to(s),
      )
      .build();

    await t.test();

    expect(callableEnricher).toHaveBeenCalledTimes(1);
    expect(s.received).toHaveLength(1);
    expect(s.received[0].body).toEqual({ original: "value", enriched: "data" });
  });
});
