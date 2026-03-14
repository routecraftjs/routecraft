import { describe, test, expect, afterEach } from "vitest";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import { craft, simple, html, type HtmlResult } from "@routecraft/routecraft";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

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
      const s = spy();
      const htmlString = "<html><title>Hello World</title></html>";

      t = await testContext()
        .routes(
          craft()
            .id("html-text-single")
            .from(simple(htmlString))
            .transform(html({ selector: "title", extract: "text" }))
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(s.received).toHaveLength(1);
      const body = s.received[0].body as HtmlResult;
      expect(body).toBe("Hello World");
    });

    /**
     * @case Extract inner HTML from single element
     * @preconditions extract: "html", selector matches one element
     * @expectedResult Inner HTML string is returned
     */
    test("extracts html from single element", async () => {
      const s = spy();
      const htmlString = '<div class="wrap"><span>inner</span></div>';

      t = await testContext()
        .routes(
          craft()
            .id("html-html-single")
            .from(simple(htmlString))
            .transform(html({ selector: ".wrap", extract: "html" }))
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(s.received).toHaveLength(1);
      const body = s.received[0].body as HtmlResult;
      expect(body).toContain("<span>inner</span>");
    });

    /**
     * @case Extract attribute value from single element
     * @preconditions extract: "attr", attr option set, selector matches one element
     * @expectedResult Attribute value string is returned
     */
    test("extracts attr from single element", async () => {
      const s = spy();
      const htmlString = '<a href="https://example.com">link</a>';

      t = await testContext()
        .routes(
          craft()
            .id("html-attr-single")
            .from(simple(htmlString))
            .transform(html({ selector: "a", extract: "attr", attr: "href" }))
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(s.received).toHaveLength(1);
      const body = s.received[0].body as HtmlResult;
      expect(body).toBe("https://example.com");
    });

    /**
     * @case Default extract is "text"
     * @preconditions No extract option
     * @expectedResult Text content is returned
     */
    test("default extract is text", async () => {
      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("html-default-extract")
            .from(simple("<p>Default text</p>"))
            .transform(html({ selector: "p" }))
            .to(s),
        )
        .build();

      await t.ctx.start();

      const body = s.received[0].body as HtmlResult;
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
      const s = spy();
      const htmlString = "<ul><li>one</li><li>two</li><li>three</li></ul>";

      t = await testContext()
        .routes(
          craft()
            .id("html-multi")
            .from(simple(htmlString))
            .transform(html({ selector: "li", extract: "text" }))
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(s.received).toHaveLength(1);
      const body = s.received[0].body as HtmlResult;
      expect(Array.isArray(body)).toBe(true);
      expect(body).toEqual(["one", "two", "three"]);
    });

    /**
     * @case Multiple elements with attr extraction
     * @preconditions Selector matches multiple links
     * @expectedResult Array of href values
     */
    test("multi-element attr returns array", async () => {
      const s = spy();
      const htmlString = '<a href="/a">A</a><a href="/b">B</a>';

      t = await testContext()
        .routes(
          craft()
            .id("html-multi-attr")
            .from(simple(htmlString))
            .transform(html({ selector: "a", extract: "attr", attr: "href" }))
            .to(s),
        )
        .build();

      await t.ctx.start();

      const body = s.received[0].body as HtmlResult;
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
      const s = spy();
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
            .to(s),
        )
        .build();

      await t.ctx.start();

      const body = s.received[0].body as HtmlResult;
      expect(body).toBe("From body.body");
    });

    /**
     * @case Pluck HTML from custom property via from (e.g. body.html)
     * @preconditions Body is object with HTML in a field, from() provided
     * @expectedResult Extraction uses the plucked HTML
     */
    test("from option plucks HTML from nested body", async () => {
      const s = spy();
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
            .to(s),
        )
        .build();

      await t.ctx.start();

      const body = s.received[0].body as HtmlResult;
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
      const s = spy();
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
            .to(s),
        )
        .build();

      await t.ctx.start();

      const body = s.received[0].body as {
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
      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("html-no-match")
            .from(simple("<div>content</div>"))
            .transform(html({ selector: ".missing", extract: "text" }))
            .to(s),
        )
        .build();

      await t.ctx.start();

      const body = s.received[0].body as HtmlResult;
      expect(body).toBe("");
    });
  });

  describe("source mode (with path)", () => {
    let tempDir: string;
    let testFile: string;

    afterEach(async () => {
      // Clean up temp files
      if (tempDir) {
        try {
          await fs.rm(tempDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      }
    });

    /**
     * @case Read HTML file and extract text using selector
     * @preconditions HTML file exists with content
     * @expectedResult Text is extracted from file
     */
    test("reads HTML file and extracts text", async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "html-test-"));
      testFile = path.join(tempDir, "test.html");
      await fs.writeFile(
        testFile,
        "<html><head><title>File Title</title></head><body><h1>Hello from file</h1></body></html>",
      );

      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("html-source-text")
            .from(html({ path: testFile, selector: "h1", extract: "text" }))
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(s.received).toHaveLength(1);
      const body = s.received[0].body as HtmlResult;
      expect(body).toBe("Hello from file");
    });

    /**
     * @case Read HTML file and extract multiple elements
     * @preconditions HTML file with multiple matching elements
     * @expectedResult Array of extracted values
     */
    test("reads HTML file and extracts multiple elements", async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "html-test-"));
      testFile = path.join(tempDir, "list.html");
      await fs.writeFile(
        testFile,
        "<html><body><ul><li>Item 1</li><li>Item 2</li><li>Item 3</li></ul></body></html>",
      );

      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("html-source-multi")
            .from(html({ path: testFile, selector: "li", extract: "text" }))
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(s.received).toHaveLength(1);
      const body = s.received[0].body as HtmlResult;
      expect(Array.isArray(body)).toBe(true);
      expect(body).toEqual(["Item 1", "Item 2", "Item 3"]);
    });

    /**
     * @case Read HTML file and extract attribute
     * @preconditions HTML file with element having attribute
     * @expectedResult Attribute value is extracted
     */
    test("reads HTML file and extracts attribute", async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "html-test-"));
      testFile = path.join(tempDir, "links.html");
      await fs.writeFile(
        testFile,
        '<html><body><a href="https://example.com">Link</a></body></html>',
      );

      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("html-source-attr")
            .from(
              html({
                path: testFile,
                selector: "a",
                extract: "attr",
                attr: "href",
              }),
            )
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(s.received).toHaveLength(1);
      const body = s.received[0].body as HtmlResult;
      expect(body).toBe("https://example.com");
    });
  });

  describe("destination mode (with path)", () => {
    let tempDir: string;
    let testFile: string;

    afterEach(async () => {
      // Clean up temp files
      if (tempDir) {
        try {
          await fs.rm(tempDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      }
    });

    /**
     * @case Write HTML string to file
     * @preconditions HTML string in exchange body
     * @expectedResult File is created with HTML content
     */
    test("writes HTML string to file", async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "html-test-"));
      testFile = path.join(tempDir, "output.html");

      const htmlContent =
        "<html><head><title>Output</title></head><body><h1>Generated HTML</h1></body></html>";

      t = await testContext()
        .routes(
          craft()
            .id("html-dest-write")
            .from(simple(htmlContent))
            .to(html({ path: testFile, mode: "write" })),
        )
        .build();

      await t.ctx.start();

      // Verify file was created with correct content
      const fileContent = await fs.readFile(testFile, "utf-8");
      expect(fileContent).toBe(htmlContent);
    });

    /**
     * @case Write HTML from body.body object
     * @preconditions Exchange body is object with body property containing HTML
     * @expectedResult File is created with HTML from body.body
     */
    test("writes HTML from body.body to file", async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "html-test-"));
      testFile = path.join(tempDir, "output.html");

      const httpLike = {
        status: 200,
        headers: {} as Record<string, string>,
        body: "<html><body><p>From body.body</p></body></html>",
        url: "https://example.com",
      };

      t = await testContext()
        .routes(
          craft()
            .id("html-dest-body-body")
            .from(simple(httpLike))
            .to(html({ path: testFile, mode: "write" })),
        )
        .build();

      await t.ctx.start();

      // Verify file was created with correct content
      const fileContent = await fs.readFile(testFile, "utf-8");
      expect(fileContent).toBe(httpLike.body);
    });

    /**
     * @case Create parent directories when writing HTML
     * @preconditions createDirs is true, parent directory doesn't exist
     * @expectedResult Parent directories are created, file is written
     */
    test("creates parent directories when createDirs is true", async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "html-test-"));
      testFile = path.join(tempDir, "nested", "dir", "output.html");

      const htmlContent = "<html><body><p>Nested file</p></body></html>";

      t = await testContext()
        .routes(
          craft()
            .id("html-dest-createDirs")
            .from(simple(htmlContent))
            .to(html({ path: testFile, mode: "write", createDirs: true })),
        )
        .build();

      await t.ctx.start();

      // Verify file was created with correct content
      const fileContent = await fs.readFile(testFile, "utf-8");
      expect(fileContent).toBe(htmlContent);
    });
  });
});
