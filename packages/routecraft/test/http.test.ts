import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import {
  craft,
  simple,
  http,
  DefaultExchange,
  getExchangeContext,
} from "@routecraft/routecraft";

describe("HTTP Adapter", () => {
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
   * @case Verifies that JSON object responses are auto-parsed
   * @preconditions HTTP adapter returns JSON with application/json content-type
   * @expectedResult Body should be parsed as JSON object
   */
  test("auto-parses JSON object response", async () => {
    const jsonData = { name: "John", age: 30 };
    const s = spy();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      text: async () => JSON.stringify(jsonData),
      url: "https://api.example.com/user",
    });

    t = await testContext()
      .routes(
        craft()
          .id("test-json-object")
          .from(simple("trigger"))
          .enrich(http({ url: "https://api.example.com/user" }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    const enrichedBody = s.received[0].body as any;
    // Enrich merges the HttpResult into the body
    expect(enrichedBody.body).toEqual(jsonData);
    expect(typeof enrichedBody.body).toBe("object");
  });

  /**
   * @case Verifies that JSON array responses are auto-parsed
   * @preconditions HTTP adapter returns JSON array with application/json content-type
   * @expectedResult Body should be parsed as array
   */
  test("auto-parses JSON array response", async () => {
    const jsonArray = [1, 2, 3, 4, 5];
    const s = spy();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      text: async () => JSON.stringify(jsonArray),
      url: "https://api.example.com/numbers",
    });

    t = await testContext()
      .routes(
        craft()
          .id("test-json-array")
          .from(simple("trigger"))
          .enrich(http({ url: "https://api.example.com/numbers" }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    const enrichedBody = s.received[0].body as any;
    // Enrich merges the HttpResult into the body
    expect(enrichedBody.body).toEqual(jsonArray);
    expect(Array.isArray(enrichedBody.body)).toBe(true);
  });

  /**
   * @case Verifies that JSON with charset parameter is handled correctly
   * @preconditions HTTP adapter returns JSON with application/json; charset=utf-8
   * @expectedResult Body should be parsed as JSON
   */
  test("auto-parses JSON with charset parameter", async () => {
    const jsonData = { status: "success" };
    const s = spy();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json; charset=utf-8"]]),
      text: async () => JSON.stringify(jsonData),
      url: "https://api.example.com/status",
    });

    t = await testContext()
      .routes(
        craft()
          .id("test-json-charset")
          .from(simple("trigger"))
          .enrich(http({ url: "https://api.example.com/status" }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    const enrichedBody = s.received[0].body as any;
    // Enrich merges the HttpResult into the body
    expect(enrichedBody.body).toEqual(jsonData);
  });

  /**
   * @case Verifies that plain text responses remain as strings
   * @preconditions HTTP adapter returns text/plain content-type
   * @expectedResult Body should remain as string
   */
  test("returns plain text as string", async () => {
    const textData = "Hello, World!";
    const s = spy();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "text/plain"]]),
      text: async () => textData,
      url: "https://api.example.com/text",
    });

    t = await testContext()
      .routes(
        craft()
          .id("test-plain-text")
          .from(simple("trigger"))
          .enrich(http({ url: "https://api.example.com/text" }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    const enrichedBody = s.received[0].body as any;
    // Enrich merges the HttpResult into the body
    expect(enrichedBody.body).toBe(textData);
    expect(typeof enrichedBody.body).toBe("string");
  });

  /**
   * @case Verifies that XML responses remain as strings
   * @preconditions HTTP adapter returns text/xml content-type
   * @expectedResult Body should remain as string
   */
  test("returns XML as string", async () => {
    const xmlData = '<?xml version="1.0"?><root><item>value</item></root>';
    const s = spy();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "text/xml"]]),
      text: async () => xmlData,
      url: "https://api.example.com/data.xml",
    });

    t = await testContext()
      .routes(
        craft()
          .id("test-xml")
          .from(simple("trigger"))
          .enrich(http({ url: "https://api.example.com/data.xml" }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    const enrichedBody = s.received[0].body as any;
    // Enrich merges the HttpResult into the body
    expect(enrichedBody.body).toBe(xmlData);
    expect(typeof enrichedBody.body).toBe("string");
  });

  /**
   * @case Verifies that HTML responses remain as strings
   * @preconditions HTTP adapter returns text/html content-type
   * @expectedResult Body should remain as string
   */
  test("returns HTML as string", async () => {
    const htmlData = "<html><body>Hello</body></html>";
    const s = spy();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "text/html"]]),
      text: async () => htmlData,
      url: "https://example.com/page",
    });

    t = await testContext()
      .routes(
        craft()
          .id("test-html")
          .from(simple("trigger"))
          .enrich(http({ url: "https://example.com/page" }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    const enrichedBody = s.received[0].body as any;
    // Enrich merges the HttpResult into the body
    expect(enrichedBody.body).toBe(htmlData);
    expect(typeof enrichedBody.body).toBe("string");
  });

  /**
   * @case Verifies handling of missing Content-Type header
   * @preconditions HTTP response has no content-type header
   * @expectedResult Body should remain as string
   */
  test("returns string when content-type is missing", async () => {
    const textData = "No content type";
    const s = spy();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map(),
      text: async () => textData,
      url: "https://api.example.com/data",
    });

    t = await testContext()
      .routes(
        craft()
          .id("test-no-content-type")
          .from(simple("trigger"))
          .enrich(http({ url: "https://api.example.com/data" }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    const enrichedBody = s.received[0].body as any;
    // Enrich merges the HttpResult into the body
    expect(enrichedBody.body).toBe(textData);
    expect(typeof enrichedBody.body).toBe("string");
  });

  /**
   * @case Verifies graceful handling of malformed JSON
   * @preconditions HTTP adapter returns invalid JSON with application/json content-type
   * @expectedResult Body should fallback to string
   */
  test("falls back to string for malformed JSON", async () => {
    const malformedJson = '{"invalid": json}';
    const s = spy();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      text: async () => malformedJson,
      url: "https://api.example.com/bad",
    });

    t = await testContext()
      .routes(
        craft()
          .id("test-malformed-json")
          .from(simple("trigger"))
          .enrich(http({ url: "https://api.example.com/bad" }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    const enrichedBody = s.received[0].body as any;
    // Enrich merges the HttpResult into the body
    expect(enrichedBody.body).toBe(malformedJson);
    expect(typeof enrichedBody.body).toBe("string");
  });

  /**
   * @case Verifies handling of empty JSON response
   * @preconditions HTTP adapter returns empty string with application/json content-type
   * @expectedResult Body should fallback to empty string
   */
  test("handles empty JSON response", async () => {
    const s = spy();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      text: async () => "",
      url: "https://api.example.com/empty",
    });

    t = await testContext()
      .routes(
        craft()
          .id("test-empty-json")
          .from(simple("trigger"))
          .enrich(http({ url: "https://api.example.com/empty" }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    const enrichedBody = s.received[0].body as any;
    // Enrich merges the HttpResult into the body
    expect(enrichedBody.body).toBe("");
    expect(typeof enrichedBody.body).toBe("string");
  });

  /**
   * @case Verifies JSON array can be used with split operation
   * @preconditions HTTP adapter returns JSON array that needs to be split
   * @expectedResult Array should be auto-parsed and splittable
   */
  test("JSON array integrates with split operation", async () => {
    const items = [
      { id: 1, name: "Item 1" },
      { id: 2, name: "Item 2" },
      { id: 3, name: "Item 3" },
    ];
    const s = spy();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      text: async () => JSON.stringify(items),
      url: "https://api.example.com/items",
    });

    t = await testContext()
      .routes(
        craft()
          .id("test-split-integration")
          .from(simple("trigger"))
          .enrich(http({ url: "https://api.example.com/items" }))
          .split((exchange) => {
            const ctx = getExchangeContext(exchange)!;
            const body = exchange.body as { body?: unknown[] };
            const items = Array.isArray(body?.body) ? body.body : [];
            return items.map(
              (b) =>
                new DefaultExchange(ctx, {
                  body: b,
                  headers: exchange.headers,
                }),
            );
          })
          .to(s),
      )
      .build();

    await t.ctx.start();

    // Should have been called once for each item
    expect(s.received).toHaveLength(3);
    // After split, each item is the body directly
    expect(s.received[0].body).toEqual({ id: 1, name: "Item 1" });
    expect(s.received[1].body).toEqual({ id: 2, name: "Item 2" });
    expect(s.received[2].body).toEqual({ id: 3, name: "Item 3" });
  });

  /**
   * @case Verifies .to(http()) replaces body with result
   * @preconditions http adapter used with .to()
   * @expectedResult Body replaced with HttpResult
   */
  test(".to(http()) replaces body with http result", async () => {
    const s = spy();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      text: async () => JSON.stringify({ responseData: "value" }),
      url: "https://api.example.com/webhook",
    });

    t = await testContext()
      .routes(
        craft()
          .id("test-to-http-replaces-body")
          .from(simple({ original: "data" }))
          .to(http({ method: "POST", url: "https://api.example.com/webhook" }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(s.received).toHaveLength(1);
    const finalBody = s.received[0].body as any;
    // Body should be replaced with HttpResult
    expect(finalBody.status).toBe(200);
    expect(finalBody.body).toEqual({ responseData: "value" });
  });

  /**
   * @case Verifies chaining .to() calls
   * @preconditions Multiple .to(http()) calls
   * @expectedResult Each .to() replaces body sequentially
   */
  test("chaining .to(http()) calls", async () => {
    const s = spy();

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([["content-type", "application/json"]]),
        text: async () => JSON.stringify({ step: 1 }),
        url: "https://api.example.com/step1",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: new Map([["content-type", "application/json"]]),
        text: async () => JSON.stringify({ step: 2 }),
        url: "https://api.example.com/step2",
      });

    t = await testContext()
      .routes(
        craft()
          .id("test-to-http-chain")
          .from(simple({ initial: "data" }))
          .to(http({ url: "https://api.example.com/step1" }))
          .to(http({ url: "https://api.example.com/step2" }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(s.received).toHaveLength(1);
    const finalBody = s.received[0].body as any;
    // Body should be the last HttpResult
    expect(finalBody).toMatchObject({
      status: 201,
      body: { step: 2 },
    });
  });
});
