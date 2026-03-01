import { describe, test, expect, afterEach, vi } from "vitest";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, simple, html, type HtmlResult } from "@routecraft/routecraft";

describe("HTML Adapter", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  describe("single-element extraction", () => {
    /**
     * @case Extract text from single element when body is HTML string
     * @preconditions Body is HTML string, selector matches one element
     * @expectedResult Single string (text content) is returned
     */
    test("extracts text from single element (body as HTML string)", async () => {
      const destSpy = vi.fn();
      const htmlString = "<html><title>Hello World</title></html>";

      t = await testContext()
        .routes(
          craft()
            .id("html-text-single")
            .from(simple(htmlString))
            .transform(html({ selector: "title", extract: "text" }))
            .to(destSpy),
        )
        .build();

      await t.ctx.start();

      expect(destSpy).toHaveBeenCalledTimes(1);
      const body = destSpy.mock.calls[0][0].body as HtmlResult;
      expect(body).toBe("Hello World");
    });

    /**
     * @case Extract inner HTML from single element
     * @preconditions extract: "html", selector matches one element
     * @expectedResult Inner HTML string is returned
     */
    test("extracts html from single element", async () => {
      const destSpy = vi.fn();
      const htmlString = '<div class="wrap"><span>inner</span></div>';

      t = await testContext()
        .routes(
          craft()
            .id("html-html-single")
            .from(simple(htmlString))
            .transform(html({ selector: ".wrap", extract: "html" }))
            .to(destSpy),
        )
        .build();

      await t.ctx.start();

      expect(destSpy).toHaveBeenCalledTimes(1);
      const body = destSpy.mock.calls[0][0].body as HtmlResult;
      expect(body).toContain("<span>inner</span>");
    });

    /**
     * @case Extract attribute value from single element
     * @preconditions extract: "attr", attr option set, selector matches one element
     * @expectedResult Attribute value string is returned
     */
    test("extracts attr from single element", async () => {
      const destSpy = vi.fn();
      const htmlString = '<a href="https://example.com">link</a>';

      t = await testContext()
        .routes(
          craft()
            .id("html-attr-single")
            .from(simple(htmlString))
            .transform(html({ selector: "a", extract: "attr", attr: "href" }))
            .to(destSpy),
        )
        .build();

      await t.ctx.start();

      expect(destSpy).toHaveBeenCalledTimes(1);
      const body = destSpy.mock.calls[0][0].body as HtmlResult;
      expect(body).toBe("https://example.com");
    });

    /**
     * @case Default extract is "text"
     * @preconditions No extract option
     * @expectedResult Text content is returned
     */
    test("default extract is text", async () => {
      const destSpy = vi.fn();

      t = await testContext()
        .routes(
          craft()
            .id("html-default-extract")
            .from(simple("<p>Default text</p>"))
            .transform(html({ selector: "p" }))
            .to(destSpy),
        )
        .build();

      await t.ctx.start();

      const body = destSpy.mock.calls[0][0].body as HtmlResult;
      expect(body).toBe("Default text");
    });
  });

  describe("multi-element extraction", () => {
    /**
     * @case Multiple matches return array of strings
     * @preconditions Selector matches multiple elements
     * @expectedResult Array of extracted values
     */
    test("returns array when selector matches multiple elements", async () => {
      const destSpy = vi.fn();
      const htmlString = "<ul><li>one</li><li>two</li><li>three</li></ul>";

      t = await testContext()
        .routes(
          craft()
            .id("html-multi")
            .from(simple(htmlString))
            .transform(html({ selector: "li", extract: "text" }))
            .to(destSpy),
        )
        .build();

      await t.ctx.start();

      expect(destSpy).toHaveBeenCalledTimes(1);
      const body = destSpy.mock.calls[0][0].body as HtmlResult;
      expect(Array.isArray(body)).toBe(true);
      expect(body).toEqual(["one", "two", "three"]);
    });

    /**
     * @case Multiple elements with attr extraction
     * @preconditions Selector matches multiple links
     * @expectedResult Array of href values
     */
    test("multi-element attr returns array", async () => {
      const destSpy = vi.fn();
      const htmlString = '<a href="/a">A</a><a href="/b">B</a>';

      t = await testContext()
        .routes(
          craft()
            .id("html-multi-attr")
            .from(simple(htmlString))
            .transform(html({ selector: "a", extract: "attr", attr: "href" }))
            .to(destSpy),
        )
        .build();

      await t.ctx.start();

      const body = destSpy.mock.calls[0][0].body as HtmlResult;
      expect(body).toEqual(["/a", "/b"]);
    });
  });

  describe("default and from option", () => {
    /**
     * @case By default uses body.body when body is object (e.g. after http())
     * @preconditions Body is object with string body property, no from() option
     * @expectedResult Extraction uses body.body
     */
    test("default uses body.body when body is object with body property", async () => {
      const destSpy = vi.fn();
      const httpLike = {
        status: 200,
        headers: {} as Record<string, string>,
        body: "<html><title>From body.body</title></html>",
        url: "https://example.com",
      };

      t = await testContext()
        .routes(
          craft()
            .id("html-default-body-body")
            .from(simple(httpLike))
            .transform(html({ selector: "title", extract: "text" }))
            .to(destSpy),
        )
        .build();

      await t.ctx.start();

      const body = destSpy.mock.calls[0][0].body as HtmlResult;
      expect(body).toBe("From body.body");
    });

    /**
     * @case Pluck HTML from custom property via from (e.g. body.html)
     * @preconditions Body is object with HTML in a field, from() provided
     * @expectedResult Extraction uses the plucked HTML
     */
    test("from option plucks HTML from nested body", async () => {
      const destSpy = vi.fn();
      const wrapped = {
        status: 200,
        body: "<html><h1>From nested</h1></html>",
      };

      t = await testContext()
        .routes(
          craft()
            .id("html-from")
            .from(simple(wrapped))
            .transform(
              html({
                from: (b) => b.body,
                selector: "h1",
                extract: "text",
              }),
            )
            .to(destSpy),
        )
        .build();

      await t.ctx.start();

      const body = destSpy.mock.calls[0][0].body as HtmlResult;
      expect(body).toBe("From nested");
    });
  });

  describe("to option", () => {
    /**
     * @case to option writes extracted result to a sub-field of body
     * @preconditions from plucks HTML from body.field, to writes result back to body.field
     * @expectedResult Body is { ...body, field: extractedValue }
     */
    test("to option writes result to sub-field", async () => {
      const destSpy = vi.fn();
      const wrapped = {
        id: 1,
        body: "<html><title>Sub-field title</title></html>",
      };

      t = await testContext()
        .routes(
          craft()
            .id("html-to-subfield")
            .from(simple(wrapped))
            .transform(
              html({
                from: (b) => b.body,
                selector: "title",
                extract: "text",
                to: (body, result) => ({ ...body, title: result }),
              }),
            )
            .to(destSpy),
        )
        .build();

      await t.ctx.start();

      const body = destSpy.mock.calls[0][0].body as {
        id: number;
        body: string;
        title: string;
      };
      expect(body.id).toBe(1);
      expect(body.body).toBe(wrapped.body);
      expect(body.title).toBe("Sub-field title");
    });
  });

  describe("missing selector", () => {
    /**
     * @case No elements match selector
     * @preconditions Selector matches zero elements
     * @expectedResult Empty string is returned
     */
    test("returns empty string when no match", async () => {
      const destSpy = vi.fn();

      t = await testContext()
        .routes(
          craft()
            .id("html-no-match")
            .from(simple("<div>content</div>"))
            .transform(html({ selector: ".missing", extract: "text" }))
            .to(destSpy),
        )
        .build();

      await t.ctx.start();

      const body = destSpy.mock.calls[0][0].body as HtmlResult;
      expect(body).toBe("");
    });
  });
});
