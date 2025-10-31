import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  context,
  craft,
  simple,
  fetch,
  type CraftContext,
} from "@routecraft/routecraft";

describe("Fetch Adapter", () => {
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
   * @case Verifies that JSON object responses are auto-parsed
   * @preconditions Fetch returns JSON with application/json content-type
   * @expectedResult Body should be parsed as JSON object
   */
  test("auto-parses JSON object response", async () => {
    const jsonData = { name: "John", age: 30 };
    const destSpy = vi.fn();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      text: async () => JSON.stringify(jsonData),
      url: "https://api.example.com/user",
    });

    testContext = context()
      .routes(
        craft()
          .id("test-json-object")
          .from(simple("trigger"))
          .enrich(fetch({ url: "https://api.example.com/user" }))
          .to(destSpy),
      )
      .build();

    await testContext.start();

    expect(destSpy).toHaveBeenCalledTimes(1);
    const enrichedBody = destSpy.mock.calls[0][0].body;
    // Enrich merges the FetchResult into the body
    expect(enrichedBody.body).toEqual(jsonData);
    expect(typeof enrichedBody.body).toBe("object");
  });

  /**
   * @case Verifies that JSON array responses are auto-parsed
   * @preconditions Fetch returns JSON array with application/json content-type
   * @expectedResult Body should be parsed as array
   */
  test("auto-parses JSON array response", async () => {
    const jsonArray = [1, 2, 3, 4, 5];
    const destSpy = vi.fn();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      text: async () => JSON.stringify(jsonArray),
      url: "https://api.example.com/numbers",
    });

    testContext = context()
      .routes(
        craft()
          .id("test-json-array")
          .from(simple("trigger"))
          .enrich(fetch({ url: "https://api.example.com/numbers" }))
          .to(destSpy),
      )
      .build();

    await testContext.start();

    expect(destSpy).toHaveBeenCalledTimes(1);
    const enrichedBody = destSpy.mock.calls[0][0].body;
    // Enrich merges the FetchResult into the body
    expect(enrichedBody.body).toEqual(jsonArray);
    expect(Array.isArray(enrichedBody.body)).toBe(true);
  });

  /**
   * @case Verifies that JSON with charset parameter is handled correctly
   * @preconditions Fetch returns JSON with application/json; charset=utf-8
   * @expectedResult Body should be parsed as JSON
   */
  test("auto-parses JSON with charset parameter", async () => {
    const jsonData = { status: "success" };
    const destSpy = vi.fn();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json; charset=utf-8"]]),
      text: async () => JSON.stringify(jsonData),
      url: "https://api.example.com/status",
    });

    testContext = context()
      .routes(
        craft()
          .id("test-json-charset")
          .from(simple("trigger"))
          .enrich(fetch({ url: "https://api.example.com/status" }))
          .to(destSpy),
      )
      .build();

    await testContext.start();

    expect(destSpy).toHaveBeenCalledTimes(1);
    const enrichedBody = destSpy.mock.calls[0][0].body;
    // Enrich merges the FetchResult into the body
    expect(enrichedBody.body).toEqual(jsonData);
  });

  /**
   * @case Verifies that plain text responses remain as strings
   * @preconditions Fetch returns text/plain content-type
   * @expectedResult Body should remain as string
   */
  test("returns plain text as string", async () => {
    const textData = "Hello, World!";
    const destSpy = vi.fn();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "text/plain"]]),
      text: async () => textData,
      url: "https://api.example.com/text",
    });

    testContext = context()
      .routes(
        craft()
          .id("test-plain-text")
          .from(simple("trigger"))
          .enrich(fetch({ url: "https://api.example.com/text" }))
          .to(destSpy),
      )
      .build();

    await testContext.start();

    expect(destSpy).toHaveBeenCalledTimes(1);
    const enrichedBody = destSpy.mock.calls[0][0].body;
    // Enrich merges the FetchResult into the body
    expect(enrichedBody.body).toBe(textData);
    expect(typeof enrichedBody.body).toBe("string");
  });

  /**
   * @case Verifies that XML responses remain as strings
   * @preconditions Fetch returns text/xml content-type
   * @expectedResult Body should remain as string
   */
  test("returns XML as string", async () => {
    const xmlData = '<?xml version="1.0"?><root><item>value</item></root>';
    const destSpy = vi.fn();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "text/xml"]]),
      text: async () => xmlData,
      url: "https://api.example.com/data.xml",
    });

    testContext = context()
      .routes(
        craft()
          .id("test-xml")
          .from(simple("trigger"))
          .enrich(fetch({ url: "https://api.example.com/data.xml" }))
          .to(destSpy),
      )
      .build();

    await testContext.start();

    expect(destSpy).toHaveBeenCalledTimes(1);
    const enrichedBody = destSpy.mock.calls[0][0].body;
    // Enrich merges the FetchResult into the body
    expect(enrichedBody.body).toBe(xmlData);
    expect(typeof enrichedBody.body).toBe("string");
  });

  /**
   * @case Verifies that HTML responses remain as strings
   * @preconditions Fetch returns text/html content-type
   * @expectedResult Body should remain as string
   */
  test("returns HTML as string", async () => {
    const htmlData = "<html><body>Hello</body></html>";
    const destSpy = vi.fn();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "text/html"]]),
      text: async () => htmlData,
      url: "https://example.com/page",
    });

    testContext = context()
      .routes(
        craft()
          .id("test-html")
          .from(simple("trigger"))
          .enrich(fetch({ url: "https://example.com/page" }))
          .to(destSpy),
      )
      .build();

    await testContext.start();

    expect(destSpy).toHaveBeenCalledTimes(1);
    const enrichedBody = destSpy.mock.calls[0][0].body;
    // Enrich merges the FetchResult into the body
    expect(enrichedBody.body).toBe(htmlData);
    expect(typeof enrichedBody.body).toBe("string");
  });

  /**
   * @case Verifies handling of missing Content-Type header
   * @preconditions Fetch response has no content-type header
   * @expectedResult Body should remain as string
   */
  test("returns string when content-type is missing", async () => {
    const textData = "No content type";
    const destSpy = vi.fn();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map(),
      text: async () => textData,
      url: "https://api.example.com/data",
    });

    testContext = context()
      .routes(
        craft()
          .id("test-no-content-type")
          .from(simple("trigger"))
          .enrich(fetch({ url: "https://api.example.com/data" }))
          .to(destSpy),
      )
      .build();

    await testContext.start();

    expect(destSpy).toHaveBeenCalledTimes(1);
    const enrichedBody = destSpy.mock.calls[0][0].body;
    // Enrich merges the FetchResult into the body
    expect(enrichedBody.body).toBe(textData);
    expect(typeof enrichedBody.body).toBe("string");
  });

  /**
   * @case Verifies graceful handling of malformed JSON
   * @preconditions Fetch returns invalid JSON with application/json content-type
   * @expectedResult Body should fallback to string
   */
  test("falls back to string for malformed JSON", async () => {
    const malformedJson = '{"invalid": json}';
    const destSpy = vi.fn();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      text: async () => malformedJson,
      url: "https://api.example.com/bad",
    });

    testContext = context()
      .routes(
        craft()
          .id("test-malformed-json")
          .from(simple("trigger"))
          .enrich(fetch({ url: "https://api.example.com/bad" }))
          .to(destSpy),
      )
      .build();

    await testContext.start();

    expect(destSpy).toHaveBeenCalledTimes(1);
    const enrichedBody = destSpy.mock.calls[0][0].body;
    // Enrich merges the FetchResult into the body
    expect(enrichedBody.body).toBe(malformedJson);
    expect(typeof enrichedBody.body).toBe("string");
  });

  /**
   * @case Verifies handling of empty JSON response
   * @preconditions Fetch returns empty string with application/json content-type
   * @expectedResult Body should fallback to empty string
   */
  test("handles empty JSON response", async () => {
    const destSpy = vi.fn();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      text: async () => "",
      url: "https://api.example.com/empty",
    });

    testContext = context()
      .routes(
        craft()
          .id("test-empty-json")
          .from(simple("trigger"))
          .enrich(fetch({ url: "https://api.example.com/empty" }))
          .to(destSpy),
      )
      .build();

    await testContext.start();

    expect(destSpy).toHaveBeenCalledTimes(1);
    const enrichedBody = destSpy.mock.calls[0][0].body;
    // Enrich merges the FetchResult into the body
    expect(enrichedBody.body).toBe("");
    expect(typeof enrichedBody.body).toBe("string");
  });

  /**
   * @case Verifies JSON array can be used with split operation
   * @preconditions Fetch returns JSON array that needs to be split
   * @expectedResult Array should be auto-parsed and splittable
   */
  test("JSON array integrates with split operation", async () => {
    const items = [
      { id: 1, name: "Item 1" },
      { id: 2, name: "Item 2" },
      { id: 3, name: "Item 3" },
    ];
    const destSpy = vi.fn();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      text: async () => JSON.stringify(items),
      url: "https://api.example.com/items",
    });

    testContext = context()
      .routes(
        craft()
          .id("test-split-integration")
          .from(simple("trigger"))
          .enrich(fetch({ url: "https://api.example.com/items" }))
          .split((body: any) => (Array.isArray(body.body) ? body.body : []))
          .to(destSpy),
      )
      .build();

    await testContext.start();

    // Should have been called once for each item
    expect(destSpy).toHaveBeenCalledTimes(3);
    // After split, each item is the body directly
    expect(destSpy.mock.calls[0][0].body).toEqual({ id: 1, name: "Item 1" });
    expect(destSpy.mock.calls[1][0].body).toEqual({ id: 2, name: "Item 2" });
    expect(destSpy.mock.calls[2][0].body).toEqual({ id: 3, name: "Item 3" });
  });
});
