import { describe, test, expect, afterEach, vi, beforeEach } from "vitest";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  simple,
  json,
  JsonAdapter,
  type Source,
} from "@routecraft/routecraft";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

describe("JSON Adapter", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  describe("parse", () => {
    /**
     * @case Parses JSON string and returns full object when no path option
     * @preconditions Body is JSON string, no path option
     * @expectedResult Full parsed object is returned
     */
    test("parses JSON string and returns full object when no path", async () => {
      const destSpy = vi.fn();
      const payload = { data: { name: "test" } };

      t = await testContext()
        .routes(
          craft()
            .id("json-parse-full")
            .from(simple(JSON.stringify(payload)))
            .transform(json())
            .to(destSpy),
        )
        .build();

      await t.ctx.start();

      expect(destSpy).toHaveBeenCalledTimes(1);
      expect(destSpy.mock.calls[0][0].body).toEqual(payload);
    });

    /**
     * @case Default uses body.body when body is object (e.g. after http)
     * @preconditions Body is object with string body property, no from option
     * @expectedResult Parsed JSON from body.body is returned
     */
    test("default uses body.body when body is object (e.g. after http)", async () => {
      const destSpy = vi.fn();
      const payload = { id: 1, title: "From body.body" };
      const httpLike = {
        status: 200,
        headers: {} as Record<string, string>,
        body: JSON.stringify(payload),
        url: "https://api.example.com",
      };

      t = await testContext()
        .routes(
          craft()
            .id("json-default-body-body")
            .from(simple(httpLike))
            .transform(json())
            .to(destSpy),
        )
        .build();

      await t.ctx.start();

      expect(destSpy.mock.calls[0][0].body).toEqual(payload);
    });

    /**
     * @case Invalid JSON string throws from transform
     * @preconditions Body is invalid JSON string
     * @expectedResult transform() throws with message containing "failed to parse"
     */
    test("invalid JSON throws from transform", () => {
      const adapter = new JsonAdapter({});
      expect(() => adapter.transform("not json {")).toThrow(
        /json adapter: failed to parse/,
      );
    });
  });

  describe("path extraction", () => {
    /**
     * @case path option extracts nested value by dot notation
     * @preconditions path like "data.user.name" on parsed object
     * @expectedResult Value at path is returned
     */
    test("path extracts nested value", async () => {
      const destSpy = vi.fn();
      const payload = { data: { user: { name: "Alice" } } };

      t = await testContext()
        .routes(
          craft()
            .id("json-path-nested")
            .from(simple(JSON.stringify(payload)))
            .transform(json({ path: "data.user.name" }))
            .to(destSpy),
        )
        .build();

      await t.ctx.start();

      expect(destSpy.mock.calls[0][0].body).toBe("Alice");
    });

    /**
     * @case path with array index e.g. items[0].id
     * @preconditions path includes [index] segment
     * @expectedResult Value at path including array element is returned
     */
    test("path with array index", async () => {
      const destSpy = vi.fn();
      const payload = { items: [{ id: 1 }, { id: 2 }] };

      t = await testContext()
        .routes(
          craft()
            .id("json-path-array")
            .from(simple(JSON.stringify(payload)))
            .transform(json({ path: "items[0].id" }))
            .to(destSpy),
        )
        .build();

      await t.ctx.start();

      expect(destSpy.mock.calls[0][0].body).toBe(1);
    });

    /**
     * @case path to missing key returns undefined
     * @preconditions path references non-existent key
     * @expectedResult undefined is returned
     */
    test("path to missing key returns undefined", async () => {
      const destSpy = vi.fn();

      t = await testContext()
        .routes(
          craft()
            .id("json-path-missing")
            .from(simple(JSON.stringify({ a: 1 })))
            .transform(json({ path: "b.c" }))
            .to(destSpy),
        )
        .build();

      await t.ctx.start();

      expect(destSpy.mock.calls[0][0].body).toBeUndefined();
    });
  });

  describe("from option", () => {
    /**
     * @case from option plucks JSON string from custom property
     * @preconditions Body is object, from() returns string from custom key
     * @expectedResult Parsed JSON from that string is returned
     */
    test("from option plucks JSON string from custom property", async () => {
      const destSpy = vi.fn();
      const payload = { value: 42 };
      const wrapped = { raw: JSON.stringify(payload) };

      t = await testContext()
        .routes(
          craft()
            .id("json-from")
            .from(simple(wrapped))
            .transform(json({ from: (b) => b.raw }))
            .to(destSpy),
        )
        .build();

      await t.ctx.start();

      expect(destSpy.mock.calls[0][0].body).toEqual(payload);
    });
  });

  describe("getValue option", () => {
    /**
     * @case getValue extracts/transforms parsed value; result is typed and becomes body when no to
     * @preconditions path + getValue return object
     * @expectedResult Body is the return value of getValue
     */
    test("getValue transforms path result and replaces body", async () => {
      const destSpy = vi.fn();
      const payload = { data: { name: "Alice", count: 2 } };

      t = await testContext()
        .routes(
          craft()
            .id("json-getValue")
            .from(simple(JSON.stringify(payload)))
            .transform(
              json({
                path: "data",
                getValue: (p) =>
                  typeof p === "object" && p !== null && "name" in p
                    ? { extracted: (p as { name: string }).name }
                    : { extracted: "" },
              }),
            )
            .to(destSpy),
        )
        .build();

      await t.ctx.start();

      expect(destSpy.mock.calls[0][0].body).toEqual({
        extracted: "Alice",
      });
    });
  });

  describe("to option", () => {
    /**
     * @case to option writes parsed result to a sub-field of body
     * @preconditions from plucks JSON string, to writes result to body.parsed
     * @expectedResult Body is { ...body, parsed: result }
     */
    test("to option writes result to sub-field", async () => {
      const destSpy = vi.fn();
      const payload = { data: { x: 1 } };
      const wrapped = {
        status: 200,
        body: JSON.stringify(payload),
      };

      t = await testContext()
        .routes(
          craft()
            .id("json-to-subfield")
            .from(simple(wrapped))
            .transform(
              json({
                to: (body, result) => ({ ...body, parsed: result }),
              }),
            )
            .to(destSpy),
        )
        .build();

      await t.ctx.start();

      const out = destSpy.mock.calls[0][0].body as {
        status: number;
        body: string;
        parsed: unknown;
      };
      expect(out.status).toBe(200);
      expect(out.body).toBe(JSON.stringify(payload));
      expect(out.parsed).toEqual(payload);
    });
  });

  describe("file source mode", () => {
    let tempDir: string;
    let testFilePath: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "json-test-"));
      testFilePath = path.join(tempDir, "test.json");
    });

    afterEach(async () => {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    /**
     * @case Read JSON file and parse it as source
     * @preconditions JSON file exists with valid content
     * @expectedResult Parsed JSON object is emitted
     */
    test("reads and parses JSON file", async () => {
      const data = { name: "Alice", age: 30 };
      await fs.writeFile(testFilePath, JSON.stringify(data));

      const destSpy = vi.fn();

      const adapter = json({
        path: testFilePath,
      }) as unknown as Source<unknown>;

      t = await testContext()
        .routes(craft().id("json-source-read").from(adapter).to(destSpy))
        .build();

      await t.ctx.start();

      expect(destSpy).toHaveBeenCalledTimes(1);
      expect(destSpy.mock.calls[0][0].body).toEqual(data);
    });

    /**
     * @case Invalid JSON in file throws error
     * @preconditions File contains invalid JSON
     * @expectedResult Error thrown with "failed to parse" message
     */
    test("invalid JSON file throws error", async () => {
      await fs.writeFile(testFilePath, "{ invalid json }");

      const destSpy = vi.fn();

      t = await testContext()
        .routes(
          craft()
            .id("json-source-invalid")
            .from(json({ path: testFilePath }) as unknown as Source<unknown>)
            .to(destSpy),
        )
        .build();

      const errSpy = vi.fn();
      t.ctx.on("error", errSpy);
      await t.ctx.start();
      await new Promise((r) => setTimeout(r, 0));
      expect(errSpy).toHaveBeenCalled();
      const errorPayload = errSpy.mock.calls[0][0];
      const error = errorPayload.details.error;
      expect(error.message).toMatch(/failed to parse JSON/);
    });

    /**
     * @case Missing file throws error
     * @preconditions File does not exist
     * @expectedResult Error thrown with "file not found" message
     */
    test("missing file throws error", async () => {
      const nonExistentPath = path.join(tempDir, "nonexistent.json");

      const destSpy = vi.fn();

      t = await testContext()
        .routes(
          craft()
            .id("json-source-missing")
            .from(json({ path: nonExistentPath }) as unknown as Source<unknown>)
            .to(destSpy),
        )
        .build();

      const errSpy = vi.fn();
      t.ctx.on("error", errSpy);
      await t.ctx.start();
      await new Promise((r) => setTimeout(r, 0));
      expect(errSpy).toHaveBeenCalled();
      const errorPayload = errSpy.mock.calls[0][0];
      const error = errorPayload.details.error;
      expect(error.message).toMatch(/file not found/);
    });
  });

  describe("file destination mode", () => {
    let tempDir: string;
    let testFilePath: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "json-test-"));
      testFilePath = path.join(tempDir, "output.json");
    });

    afterEach(async () => {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    /**
     * @case Write object to JSON file
     * @preconditions Object in exchange body
     * @expectedResult JSON file created with stringified content
     */
    test("writes object to JSON file", async () => {
      const data = { name: "Bob", age: 25 };

      t = await testContext()
        .routes(
          craft()
            .id("json-dest-write")
            .from(simple(data))
            .to(json({ path: testFilePath, mode: "write" })),
        )
        .build();

      await t.ctx.start();

      const written = await fs.readFile(testFilePath, "utf-8");
      expect(JSON.parse(written)).toEqual(data);
    });

    /**
     * @case Write with formatting (space option)
     * @preconditions space: 2 option
     * @expectedResult JSON file has indented formatting
     */
    test("writes formatted JSON with space option", async () => {
      const data = { name: "Charlie", nested: { value: 42 } };

      t = await testContext()
        .routes(
          craft()
            .id("json-dest-formatted")
            .from(simple(data))
            .to(json({ path: testFilePath, space: 2 })),
        )
        .build();

      await t.ctx.start();

      const written = await fs.readFile(testFilePath, "utf-8");
      expect(written).toBe(JSON.stringify(data, null, 2));
    });

    /**
     * @case Write with formatting (indent alias)
     * @preconditions indent: 2 option
     * @expectedResult JSON file has indented formatting
     */
    test("writes formatted JSON with indent option", async () => {
      const data = { key: "value" };

      t = await testContext()
        .routes(
          craft()
            .id("json-dest-indent")
            .from(simple(data))
            .to(json({ path: testFilePath, indent: 2 })),
        )
        .build();

      await t.ctx.start();

      const written = await fs.readFile(testFilePath, "utf-8");
      expect(written).toBe(JSON.stringify(data, null, 2));
    });

    /**
     * @case Create parent directories automatically
     * @preconditions createDirs: true, nested path
     * @expectedResult Parent directories created, file written
     */
    test("creates parent directories when createDirs is true", async () => {
      const nestedPath = path.join(tempDir, "nested", "dir", "output.json");
      const data = { created: true };

      t = await testContext()
        .routes(
          craft()
            .id("json-dest-mkdir")
            .from(simple(data))
            .to(json({ path: nestedPath, createDirs: true })),
        )
        .build();

      await t.ctx.start();

      const written = await fs.readFile(nestedPath, "utf-8");
      expect(JSON.parse(written)).toEqual(data);
    });

    /**
     * @case Dynamic path using exchange data
     * @preconditions path is function using exchange.body
     * @expectedResult File written to dynamic path
     */
    test("supports dynamic paths", async () => {
      const data = { id: "user-123", name: "Dynamic" };

      t = await testContext()
        .routes(
          craft()
            .id("json-dest-dynamic")
            .from(simple(data))
            .to(
              json({
                path: (ex) =>
                  path.join(tempDir, `${(ex.body as { id: string }).id}.json`),
              }),
            ),
        )
        .build();

      await t.ctx.start();

      const dynamicPath = path.join(tempDir, "user-123.json");
      const written = await fs.readFile(dynamicPath, "utf-8");
      expect(JSON.parse(written)).toEqual(data);
    });
  });

  describe("mode detection", () => {
    /**
     * @case Transformer mode when only path is dot-notation
     * @preconditions path is string without file indicators, no file options
     * @expectedResult Uses transformer mode (dot-notation extraction)
     */
    test("uses transformer mode for dot-notation path without file options", async () => {
      const destSpy = vi.fn();
      const payload = { data: { items: [{ id: 1 }] } };

      t = await testContext()
        .routes(
          craft()
            .id("json-mode-transformer")
            .from(simple(JSON.stringify(payload)))
            .transform(json({ path: "data.items" }))
            .to(destSpy),
        )
        .build();

      await t.ctx.start();

      expect(destSpy.mock.calls[0][0].body).toEqual([{ id: 1 }]);
    });

    /**
     * @case File mode when path is function
     * @preconditions path is function
     * @expectedResult Uses file mode
     */
    test("uses file mode when path is function", () => {
      const adapter = json({
        path: (ex) => `/tmp/${(ex.body as { id: string }).id}.json`,
      });
      expect(adapter).toHaveProperty(
        "adapterId",
        "routecraft.adapter.json.file",
      );
    });

    /**
     * @case File mode when mode option present
     * @preconditions mode: 'write' with path
     * @expectedResult Uses file mode
     */
    test("uses file mode when mode option present", () => {
      const adapter = json({ path: "./data.json", mode: "write" });
      expect(adapter).toHaveProperty(
        "adapterId",
        "routecraft.adapter.json.file",
      );
    });
  });
});
