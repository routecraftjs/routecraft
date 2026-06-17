import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import { craft, simple, xml, only } from "@routecraft/routecraft";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

describe("XML Adapter", () => {
  let t: TestContext;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "xml-adapter-test-"));
  });

  afterEach(async () => {
    if (t) await t.stop();
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  describe("source mode - reading XML files", () => {
    /**
     * @case Reads and parses an XML file into a plain object
     * @preconditions XML file exists with a single root element and children
     * @expectedResult Body is the parsed object with nested child values
     */
    test("reads an XML file", async () => {
      const filePath = path.join(tmpDir, "data.xml");
      await fsp.writeFile(
        filePath,
        "<note><to>Alice</to><from>Bob</from></note>",
        "utf-8",
      );

      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("xml-read")
            .from(xml({ path: filePath }))
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(s.received).toHaveLength(1);
      expect(s.received[0].body).toEqual({
        note: { to: "Alice", from: "Bob" },
      });
    });

    /**
     * @case Parses XML attributes with the default prefix
     * @preconditions XML file has an element carrying attributes
     * @expectedResult Attributes appear under the '@_' prefix alongside text
     */
    test("keeps attributes by default", async () => {
      const filePath = path.join(tmpDir, "attrs.xml");
      await fsp.writeFile(
        filePath,
        '<book id="42" lang="en">Routecraft</book>',
        "utf-8",
      );

      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("xml-attrs")
            .from(xml({ path: filePath }))
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(s.received[0].body).toEqual({
        book: { "@_id": "42", "@_lang": "en", "#text": "Routecraft" },
      });
    });
  });

  describe("destination mode - writing XML files", () => {
    /**
     * @case Builds an object body into an XML document and writes it
     * @preconditions Route body is a plain object describing one root element
     * @expectedResult File on disk contains the serialized XML
     */
    test("writes an XML file", async () => {
      const filePath = path.join(tmpDir, "out.xml");

      t = await testContext()
        .routes(
          craft()
            .id("xml-write")
            .from(simple({ note: { to: "Alice", from: "Bob" } }))
            .to(xml({ path: filePath })),
        )
        .build();

      await t.ctx.start();

      const written = await fsp.readFile(filePath, "utf-8");
      expect(written).toBe("<note><to>Alice</to><from>Bob</from></note>");
    });

    /**
     * @case Pretty-prints output when format is enabled
     * @preconditions format: true is set on the destination
     * @expectedResult Written XML contains newlines and indentation
     */
    test("formats output when format is true", async () => {
      const filePath = path.join(tmpDir, "pretty.xml");

      t = await testContext()
        .routes(
          craft()
            .id("xml-format")
            .from(simple({ note: { to: "Alice" } }))
            .to(xml({ path: filePath, format: true })),
        )
        .build();

      await t.ctx.start();

      const written = await fsp.readFile(filePath, "utf-8");
      expect(written).toContain("\n");
      expect(written).toContain("  <to>Alice</to>");
    });

    /**
     * @case Rejects a non-object body in write mode
     * @preconditions Route body is a primitive string
     * @expectedResult The exchange fails (spy receives nothing)
     */
    test("fails when the body is not an object", async () => {
      const filePath = path.join(tmpDir, "invalid.xml");
      const errors: unknown[] = [];

      t = await testContext()
        .routes(
          craft()
            .id("xml-write-invalid")
            .error((err) => {
              errors.push(err);
              return undefined;
            })
            .from(simple("not an object"))
            .to(xml({ path: filePath })),
        )
        .build();

      await t.ctx.start();
      await new Promise((r) => setTimeout(r, 0));

      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe("read mode - mid-route enrichment", () => {
    /**
     * @case Reads an XML file mid-route as a returning destination
     * @preconditions XML file exists; route enriches under a sub-field
     * @expectedResult Parsed object is merged onto the body at 'doc'
     */
    test("reads a file mid-route via enrich", async () => {
      const filePath = path.join(tmpDir, "config.xml");
      await fsp.writeFile(
        filePath,
        "<config><level>5</level></config>",
        "utf-8",
      );

      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("xml-enrich")
            .from(simple({ trigger: true }))
            .enrich(
              xml({ path: filePath, mode: "read" }),
              only((doc) => doc, "doc"),
            )
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(s.received[0].body).toEqual({
        trigger: true,
        doc: { config: { level: 5 } },
      });
    });
  });

  describe("delete mode", () => {
    /**
     * @case Deletes an XML file and passes the body through
     * @preconditions XML file exists on disk
     * @expectedResult File is removed; body is unchanged
     */
    test("deletes a file idempotently", async () => {
      const filePath = path.join(tmpDir, "gone.xml");
      await fsp.writeFile(filePath, "<a/>", "utf-8");

      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("xml-delete")
            .from(simple({ keep: true }))
            .to(xml({ path: filePath, mode: "delete" }))
            .to(s),
        )
        .build();

      await t.ctx.start();

      await expect(fsp.access(filePath)).rejects.toThrow();
      expect(s.received[0].body).toEqual({ keep: true });
    });
  });

  describe("transformer mode - parsing an XML string in the body", () => {
    /**
     * @case Parses an XML string already in the body
     * @preconditions Body is a raw XML string
     * @expectedResult Body becomes the parsed object
     */
    test("parses an XML string", async () => {
      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("xml-transform")
            .from(simple("<item><sku>A1</sku></item>"))
            .transform(xml())
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(s.received[0].body).toEqual({ item: { sku: "A1" } });
    });

    /**
     * @case Plucks the XML string via from and writes via to
     * @preconditions Body is an object carrying the XML under 'raw'
     * @expectedResult Parsed object is written to a sub-field, body preserved
     */
    test("supports from and to", async () => {
      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("xml-transform-fromto")
            .from(simple({ raw: "<x><y>1</y></x>", other: true }))
            .transform(
              xml({
                from: (b: { raw: string }) => b.raw,
                to: (b, parsed) => ({ ...b, parsed }),
              }),
            )
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(s.received[0].body).toEqual({
        raw: "<x><y>1</y></x>",
        other: true,
        parsed: { x: { y: 1 } },
      });
    });
  });

  describe("parse error handling", () => {
    /**
     * @case Malformed XML surfaces as a recoverable failure by default
     * @preconditions XML file content is structurally invalid
     * @expectedResult The route's .error() handler is invoked
     */
    test("fails on malformed XML (onParseError default)", async () => {
      const filePath = path.join(tmpDir, "broken.xml");
      await fsp.writeFile(filePath, "<note><to>Alice</from></note>", "utf-8");

      const errors: { rc?: string }[] = [];
      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("xml-parse-fail")
            .error((err) => {
              errors.push(err as { rc?: string });
              return undefined;
            })
            .from(xml({ path: filePath }))
            .to(s),
        )
        .build();

      await t.ctx.start();
      await new Promise((r) => setTimeout(r, 0));

      expect(errors.length).toBe(1);
      expect(errors[0].rc).toBe("RC5016");
      expect(s.received).toHaveLength(0);
    });

    /**
     * @case Malformed XML is dropped when onParseError is 'drop'
     * @preconditions XML file content is structurally invalid; mode 'drop'
     * @expectedResult No error handler invocation and no downstream delivery
     */
    test("drops malformed XML when onParseError is 'drop'", async () => {
      const filePath = path.join(tmpDir, "broken-drop.xml");
      await fsp.writeFile(filePath, "<note><to>Alice</from></note>", "utf-8");

      const errors: unknown[] = [];
      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("xml-parse-drop")
            .error((err) => {
              errors.push(err);
              return undefined;
            })
            .from(xml({ path: filePath, onParseError: "drop" }))
            .to(s),
        )
        .build();

      await t.ctx.start();
      await new Promise((r) => setTimeout(r, 0));

      expect(errors).toHaveLength(0);
      expect(s.received).toHaveLength(0);
    });
  });
});
