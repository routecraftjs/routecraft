import { describe, test, expect, afterEach, beforeEach } from "vitest";
import { z } from "zod";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import { craft, simple, jsonl, HeadersKeys } from "@routecraft/routecraft";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

describe("JSONL Adapter", () => {
  let t: TestContext | undefined;
  let tmpDir: string;

  beforeEach(async () => {
    t = undefined;
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "jsonl-adapter-test-"));
  });

  afterEach(async () => {
    if (t) {
      await t.stop();
      t = undefined;
    }
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  describe("source mode - non-chunked", () => {
    /**
     * @case Reads JSONL file and emits array of parsed objects
     * @preconditions JSONL file with 3 objects
     * @expectedResult Single exchange with array of 3 parsed objects
     */
    test("emits array of all parsed objects", async () => {
      const filePath = path.join(tmpDir, "data.jsonl");
      const lines = [
        JSON.stringify({ name: "Alice", age: 30 }),
        JSON.stringify({ name: "Bob", age: 25 }),
        JSON.stringify({ name: "Carol", age: 35 }),
      ];
      await fsp.writeFile(filePath, lines.join("\n"), "utf-8");

      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("jsonl-read-array")
            .from(jsonl({ path: filePath }))
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(s.received).toHaveLength(1);
      expect(s.received[0].body).toEqual([
        { name: "Alice", age: 30 },
        { name: "Bob", age: 25 },
        { name: "Carol", age: 35 },
      ]);
    });

    /**
     * @case Skips empty lines in non-chunked mode
     * @preconditions JSONL file with empty lines between records
     * @expectedResult Only non-empty lines are parsed
     */
    test("skips empty lines", async () => {
      const filePath = path.join(tmpDir, "empty-lines.jsonl");
      await fsp.writeFile(
        filePath,
        '{"a":1}\n\n{"b":2}\n  \n{"c":3}\n',
        "utf-8",
      );

      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("jsonl-skip-empty")
            .from(jsonl({ path: filePath }))
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(s.received).toHaveLength(1);
      expect(s.received[0].body).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    });

    /**
     * @case Aborts source on parse error when onParseError is 'abort'
     * @preconditions JSONL file with invalid JSON on line 2 and onParseError: 'abort'
     * @expectedResult Per-item exchange:failed fires, then context:error with RC5016
     */
    test("aborts source on parse error with onParseError: 'abort'", async () => {
      const filePath = path.join(tmpDir, "bad.jsonl");
      await fsp.writeFile(
        filePath,
        '{"valid":1}\nnot-json\n{"valid":2}',
        "utf-8",
      );

      const s = spy();
      const failed: { error: unknown }[] = [];

      t = await testContext()
        .routes(
          craft()
            .id("jsonl-non-chunked-abort")
            .from(jsonl({ path: filePath, onParseError: "abort" }))
            .to(s),
        )
        .build();

      t.ctx.on(
        "route:jsonl-non-chunked-abort:exchange:failed" as never,
        ((payload: { details: { error: unknown } }) => {
          failed.push({ error: payload.details.error });
        }) as never,
      );

      const ctxErrSpy: { error: unknown }[] = [];
      t.ctx.on("context:error", (payload) => {
        ctxErrSpy.push({ error: payload.details.error });
      });

      await t.ctx.start();
      await new Promise((r) => setTimeout(r, 0));

      expect(failed.length).toBe(1);
      expect((failed[0].error as { rc?: string }).rc).toBe("RC5016");
      expect(ctxErrSpy.length).toBeGreaterThanOrEqual(1);
    });

    /**
     * @case Uses reviver function
     * @preconditions JSONL file and reviver that transforms values
     * @expectedResult Parsed objects have transformed values
     */
    test("uses reviver function", async () => {
      const filePath = path.join(tmpDir, "reviver.jsonl");
      await fsp.writeFile(filePath, '{"count":"42"}', "utf-8");

      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("jsonl-reviver")
            .from(
              jsonl({
                path: filePath,
                reviver: (key, value) =>
                  key === "count" ? Number(value) : value,
              }),
            )
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(s.received[0].body).toEqual([{ count: 42 }]);
    });
  });

  describe("source mode - chunked", () => {
    /**
     * @case Emits one exchange per line in chunked mode
     * @preconditions JSONL file with 3 objects
     * @expectedResult 3 separate exchanges, each with a parsed object
     */
    test("emits one exchange per line", async () => {
      const filePath = path.join(tmpDir, "chunked.jsonl");
      const lines = [
        JSON.stringify({ id: 1 }),
        JSON.stringify({ id: 2 }),
        JSON.stringify({ id: 3 }),
      ];
      await fsp.writeFile(filePath, lines.join("\n"), "utf-8");

      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("jsonl-chunked")
            .from(jsonl({ path: filePath, chunked: true }))
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(s.received).toHaveLength(3);
      expect(s.received[0].body).toEqual({ id: 1 });
      expect(s.received[1].body).toEqual({ id: 2 });
      expect(s.received[2].body).toEqual({ id: 3 });
    });

    /**
     * @case Includes JSONL_LINE and JSONL_PATH headers
     * @preconditions JSONL file with 2 objects
     * @expectedResult Each exchange has correct line number and path headers
     */
    test("includes JSONL_LINE and JSONL_PATH headers", async () => {
      const filePath = path.join(tmpDir, "headers.jsonl");
      await fsp.writeFile(filePath, '{"a":1}\n{"b":2}', "utf-8");

      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("jsonl-chunked-headers")
            .from(jsonl({ path: filePath, chunked: true }))
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(s.received).toHaveLength(2);
      expect(s.received[0].headers[HeadersKeys.JSONL_LINE]).toBe(1);
      expect(s.received[0].headers[HeadersKeys.JSONL_PATH]).toBe(filePath);
      expect(s.received[1].headers[HeadersKeys.JSONL_LINE]).toBe(2);
    });

    /**
     * @case Skips empty lines in chunked mode
     * @preconditions JSONL file with empty lines between records
     * @expectedResult Only non-empty lines produce exchanges
     */
    test("skips empty lines in chunked mode", async () => {
      const filePath = path.join(tmpDir, "empty-chunked.jsonl");
      await fsp.writeFile(filePath, '{"a":1}\n\n{"b":2}\n  \n', "utf-8");

      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("jsonl-chunked-skip-empty")
            .from(jsonl({ path: filePath, chunked: true }))
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(s.received).toHaveLength(2);
      expect(s.received[0].body).toEqual({ a: 1 });
      expect(s.received[1].body).toEqual({ b: 2 });
    });

    /**
     * @case Abort mid-stream stops emitting
     * @preconditions JSONL file with many lines, abort after a few
     * @expectedResult Fewer exchanges than total lines
     */
    test("abort mid-stream stops emitting", async () => {
      const filePath = path.join(tmpDir, "many.jsonl");
      const lines = Array.from({ length: 100 }, (_, i) =>
        JSON.stringify({ id: i + 1 }),
      );
      await fsp.writeFile(filePath, lines.join("\n"), "utf-8");

      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("jsonl-chunked-abort")
            .from(jsonl({ path: filePath, chunked: true }))
            .process(async (exchange) => {
              if (s.received.length >= 2) {
                t!.ctx.stop();
              }
              return exchange;
            })
            .to(s),
        )
        .build();
      await t.ctx.start();

      expect(s.received.length).toBeGreaterThanOrEqual(1);
      expect(s.received.length).toBeLessThan(100);
    });

    /**
     * @case Chunked mode aborts source on parse error with onParseError: 'abort'
     * @preconditions JSONL file with invalid JSON, chunked mode, onParseError: 'abort'
     * @expectedResult Per-line exchange:failed fires, then context:error with RC5016
     */
    test("aborts chunked source on parse error with onParseError: 'abort'", async () => {
      const filePath = path.join(tmpDir, "bad-chunked.jsonl");
      await fsp.writeFile(filePath, '{"ok":1}\nnot-json\n{"ok":2}', "utf-8");

      const s = spy();
      const failed: { error: unknown }[] = [];

      t = await testContext()
        .routes(
          craft()
            .id("jsonl-chunked-abort")
            .from(
              jsonl({ path: filePath, chunked: true, onParseError: "abort" }),
            )
            .to(s),
        )
        .build();

      t.ctx.on(
        "route:jsonl-chunked-abort:exchange:failed" as never,
        ((payload: { details: { error: unknown } }) => {
          failed.push({ error: payload.details.error });
        }) as never,
      );

      const ctxErrSpy: { error: unknown }[] = [];
      t.ctx.on("context:error", (payload) => {
        ctxErrSpy.push({ error: payload.details.error });
      });

      await t.ctx.start();
      await new Promise((r) => setTimeout(r, 0));

      // Per-item exchange:failed fired for the bad line BEFORE the source died.
      expect(failed.length).toBe(1);
      expect((failed[0].error as { rc?: string }).rc).toBe("RC5016");
      expect(ctxErrSpy.length).toBeGreaterThanOrEqual(1);
    });

    /**
     * @case Chunked mode default 'fail' routes parse error to .error() and continues
     * @preconditions JSONL file with one bad line between two good lines, route has .error() handler
     * @expectedResult error handler invoked once with RC5016, both good lines reach the spy
     */
    test("default 'fail' routes per-line parse errors through .error() and continues", async () => {
      const filePath = path.join(tmpDir, "mixed-chunked.jsonl");
      await fsp.writeFile(filePath, '{"id":1}\nnot-json\n{"id":2}', "utf-8");

      const s = spy();
      const errors: unknown[] = [];

      t = await testContext()
        .routes(
          craft()
            .id("jsonl-chunked-fail-routes")
            .error((err) => {
              errors.push(err);
              return undefined;
            })
            .from(jsonl({ path: filePath, chunked: true }))
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(errors).toHaveLength(1);
      expect((errors[0] as { rc?: string }).rc).toBe("RC5016");
      // Two valid lines reach the destination; the bad line stopped at the
      // synthetic parse step inside the pipeline.
      expect(s.received).toHaveLength(2);
      expect(s.received[0].body).toEqual({ id: 1 });
      expect(s.received[1].body).toEqual({ id: 2 });
    });

    /**
     * @case Chunked mode 'drop' emits exchange:dropped for malformed lines and continues
     * @preconditions JSONL file with bad lines and onParseError: 'drop'
     * @expectedResult Valid lines reach the spy; exchange:dropped fires with reason "parse-failed"
     */
    test("onParseError: 'drop' emits exchange:dropped for malformed lines", async () => {
      const filePath = path.join(tmpDir, "drop-chunked.jsonl");
      await fsp.writeFile(
        filePath,
        '{"id":1}\nnot-json\n{"id":2}\nbroken{\n{"id":3}',
        "utf-8",
      );

      const s = spy();
      const dropped: { reason: string }[] = [];

      t = await testContext()
        .routes(
          craft()
            .id("jsonl-chunked-drop")
            .from(
              jsonl({ path: filePath, chunked: true, onParseError: "drop" }),
            )
            .to(s),
        )
        .build();

      t.ctx.on(
        "route:jsonl-chunked-drop:exchange:dropped" as never,
        ((payload: { details: { reason: string } }) => {
          dropped.push({ reason: payload.details.reason });
        }) as never,
      );

      await t.ctx.start();

      expect(s.received).toHaveLength(3);
      expect(s.received[0].body).toEqual({ id: 1 });
      expect(s.received[1].body).toEqual({ id: 2 });
      expect(s.received[2].body).toEqual({ id: 3 });
      expect(dropped.length).toBeGreaterThanOrEqual(2);
      expect(dropped[0].reason).toBe("parse-failed");
    });
  });

  describe("source mode - parse + .input() schema", () => {
    /**
     * @case Valid JSONL line passes input validation against the parsed body
     * @preconditions Chunked JSONL with valid lines, route has .input(zodSchema)
     * @expectedResult The schema sees the parsed object (not the raw line); spy receives the validated body
     */
    test(".input() schema validates the parsed body, not the raw line", async () => {
      const filePath = path.join(tmpDir, "valid-input.jsonl");
      await fsp.writeFile(
        filePath,
        '{"id":1,"name":"Alice"}\n{"id":2,"name":"Bob"}',
        "utf-8",
      );

      const schema = z.object({
        id: z.number(),
        name: z.string(),
      });

      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("jsonl-input-valid")
            .input({ body: schema })
            .from(jsonl({ path: filePath, chunked: true }))
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(s.received).toHaveLength(2);
      expect(s.received[0].body).toEqual({ id: 1, name: "Alice" });
      expect(s.received[1].body).toEqual({ id: 2, name: "Bob" });
    });

    /**
     * @case Input validation failure on a parsed body emits exchange:failed once (no duplicate started/dropped)
     * @preconditions Chunked JSONL with parsed body that violates schema
     * @expectedResult Exactly one exchange:started, one exchange:failed (RC5002), zero exchange:dropped per bad item
     */
    test("input validation failure inside parse step emits clean lifecycle (no duplicate started/dropped)", async () => {
      const filePath = path.join(tmpDir, "schema-fail.jsonl");
      await fsp.writeFile(
        filePath,
        '{"id":"not-a-number"}\n{"id":42}',
        "utf-8",
      );

      const schema = z.object({ id: z.number() });

      const s = spy();
      const started: string[] = [];
      const failed: { error: { rc?: string } }[] = [];
      const dropped: { reason: string }[] = [];

      t = await testContext()
        .routes(
          craft()
            .id("jsonl-input-bad")
            .input({ body: schema })
            .from(jsonl({ path: filePath, chunked: true }))
            .to(s),
        )
        .build();

      t.ctx.on(
        "route:jsonl-input-bad:exchange:started" as never,
        ((payload: { details: { exchangeId: string } }) => {
          started.push(payload.details.exchangeId);
        }) as never,
      );
      t.ctx.on(
        "route:jsonl-input-bad:exchange:failed" as never,
        ((payload: { details: { error: { rc?: string } } }) => {
          failed.push({ error: payload.details.error });
        }) as never,
      );
      t.ctx.on(
        "route:jsonl-input-bad:exchange:dropped" as never,
        ((payload: { details: { reason: string } }) => {
          dropped.push({ reason: payload.details.reason });
        }) as never,
      );

      await t.ctx.start();
      await new Promise((r) => setTimeout(r, 0));

      // Two lines processed: one bad (validation fails), one good.
      // Each line gets exactly one exchange:started.
      expect(started).toHaveLength(2);
      // The bad line fails with RC5002; no spurious exchange:dropped fired.
      expect(failed).toHaveLength(1);
      expect(failed[0].error.rc).toBe("RC5002");
      expect(dropped).toHaveLength(0);
      // The good line still reaches the destination.
      expect(s.received).toHaveLength(1);
      expect(s.received[0].body).toEqual({ id: 42 });
    });
  });

  describe("destination mode", () => {
    /**
     * @case Writes single object as JSONL line
     * @preconditions Exchange body is an object
     * @expectedResult File contains one JSON line
     */
    test("writes single object as JSONL line", async () => {
      const filePath = path.join(tmpDir, "output.jsonl");

      t = await testContext()
        .routes(
          craft()
            .id("jsonl-write-single")
            .from(simple({ name: "Alice", age: 30 }))
            .to(jsonl({ path: filePath })),
        )
        .build();

      await t.ctx.start();

      const written = await fsp.readFile(filePath, "utf-8");
      const lines = written.trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual({ name: "Alice", age: 30 });
    });

    /**
     * @case Writes array body as multiple JSONL lines via destination send
     * @preconditions Exchange body is an array of objects
     * @expectedResult File contains one JSON line per array element
     */
    test("writes array body as multiple JSONL lines", async () => {
      const filePath = path.join(tmpDir, "array-output.jsonl");
      const data = [{ id: 1 }, { id: 2 }, { id: 3 }];

      // Call destination.send directly with array body to test the
      // Array.isArray branch (simple() destructures arrays into individual exchanges)
      const dest = jsonl({ path: filePath });
      await dest.send({
        id: "test-exchange",
        body: data,
        headers: {},
        properties: {},
      } as any);

      const written = await fsp.readFile(filePath, "utf-8");
      const lines = written.trim().split("\n");
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[0])).toEqual({ id: 1 });
      expect(JSON.parse(lines[1])).toEqual({ id: 2 });
      expect(JSON.parse(lines[2])).toEqual({ id: 3 });
    });

    /**
     * @case Appends to file by default
     * @preconditions File already has content, destination mode is default (append)
     * @expectedResult New content is appended after existing content
     */
    test("appends to file by default", async () => {
      const filePath = path.join(tmpDir, "append.jsonl");
      await fsp.writeFile(filePath, '{"existing":true}\n', "utf-8");

      t = await testContext()
        .routes(
          craft()
            .id("jsonl-append")
            .from(simple({ new: true }))
            .to(jsonl({ path: filePath })),
        )
        .build();

      await t.ctx.start();

      const written = await fsp.readFile(filePath, "utf-8");
      const lines = written.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toEqual({ existing: true });
      expect(JSON.parse(lines[1])).toEqual({ new: true });
    });

    /**
     * @case Overwrites file with mode write
     * @preconditions File already has content, mode is write
     * @expectedResult File only contains new content
     */
    test("overwrites file with mode write", async () => {
      const filePath = path.join(tmpDir, "overwrite.jsonl");
      await fsp.writeFile(filePath, '{"old":true}\n', "utf-8");

      t = await testContext()
        .routes(
          craft()
            .id("jsonl-overwrite")
            .from(simple({ new: true }))
            .to(jsonl({ path: filePath, mode: "write" })),
        )
        .build();

      await t.ctx.start();

      const written = await fsp.readFile(filePath, "utf-8");
      const lines = written.trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual({ new: true });
    });

    /**
     * @case Supports dynamic path
     * @preconditions Path is function returning computed path
     * @expectedResult File is written at the dynamic path
     */
    test("supports dynamic path", async () => {
      t = await testContext()
        .routes(
          craft()
            .id("jsonl-dynamic-path")
            .from(simple({ id: "abc", data: "test" }))
            .to(
              jsonl({
                path: (ex) =>
                  path.join(
                    tmpDir,
                    `output-${(ex.body as { id: string }).id}.jsonl`,
                  ),
              }),
            ),
        )
        .build();

      await t.ctx.start();

      const filePath = path.join(tmpDir, "output-abc.jsonl");
      const written = await fsp.readFile(filePath, "utf-8");
      expect(JSON.parse(written.trim())).toEqual({ id: "abc", data: "test" });
    });

    /**
     * @case Uses replacer function
     * @preconditions Replacer function filters out specific keys
     * @expectedResult Output JSON does not contain filtered keys
     */
    test("uses replacer function", async () => {
      const filePath = path.join(tmpDir, "replacer.jsonl");

      t = await testContext()
        .routes(
          craft()
            .id("jsonl-replacer")
            .from(simple({ name: "Alice", secret: "hidden" }))
            .to(
              jsonl({
                path: filePath,
                replacer: (key: string, value: unknown) =>
                  key === "secret" ? undefined : value,
              }),
            ),
        )
        .build();

      await t.ctx.start();

      const written = await fsp.readFile(filePath, "utf-8");
      const parsed = JSON.parse(written.trim());
      expect(parsed).toEqual({ name: "Alice" });
      expect(parsed).not.toHaveProperty("secret");
    });

    /**
     * @case Creates parent directories with createDirs
     * @preconditions Nested directory does not exist, createDirs is true
     * @expectedResult Directories are created and file is written
     */
    test("creates parent directories with createDirs", async () => {
      const filePath = path.join(tmpDir, "nested", "deep", "output.jsonl");

      t = await testContext()
        .routes(
          craft()
            .id("jsonl-create-dirs")
            .from(simple({ data: true }))
            .to(jsonl({ path: filePath, createDirs: true })),
        )
        .build();

      await t.ctx.start();

      const written = await fsp.readFile(filePath, "utf-8");
      expect(JSON.parse(written.trim())).toEqual({ data: true });
    });
  });

  describe("adapterId", () => {
    /**
     * @case Adapter has correct adapterId
     * @preconditions JsonlAdapter instance created
     * @expectedResult adapterId is "routecraft.adapter.jsonl"
     */
    test("has correct adapterId for source+destination", () => {
      const adapter = jsonl({ path: "test.jsonl" });
      expect(adapter.adapterId).toBe("routecraft.adapter.jsonl");
    });

    /**
     * @case Chunked adapter has correct adapterId
     * @preconditions Chunked JsonlAdapter instance created
     * @expectedResult adapterId is "routecraft.adapter.jsonl"
     */
    test("has correct adapterId for chunked source", () => {
      const adapter = jsonl({ path: "test.jsonl", chunked: true });
      expect(adapter.adapterId).toBe("routecraft.adapter.jsonl");
    });
  });

  describe("file not found", () => {
    /**
     * @case Throws error when file not found
     * @preconditions Path points to non-existent file
     * @expectedResult Error with "file not found" message
     */
    test("throws error when file not found", async () => {
      const adapter = jsonl({ path: path.join(tmpDir, "missing.jsonl") });

      await expect(
        adapter.subscribe(
          {} as any,
          async () => ({}) as any,
          new AbortController(),
        ),
      ).rejects.toThrow(/file not found/);
    });
  });
});
