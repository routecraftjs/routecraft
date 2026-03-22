import { describe, test, expect, afterEach, beforeEach, vi } from "vitest";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import { craft, simple, file } from "@routecraft/routecraft";
import { file as createFileAdapter } from "../src/adapters/file/index.ts";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

describe("File Adapter", () => {
  let t: TestContext;
  let tmpDir: string;

  beforeEach(async () => {
    // Create a temporary directory for test files
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "file-adapter-test-"));
  });

  afterEach(async () => {
    if (t) await t.stop();
    // Clean up temporary directory
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  describe("source mode - reading files", () => {
    /**
     * @case Reads file content as string
     * @preconditions File exists with text content
     * @expectedResult File content is emitted as message body
     */
    test("reads file content as string", async () => {
      const filePath = path.join(tmpDir, "input.txt");
      const content = "Hello, World!";
      await fsp.writeFile(filePath, content, "utf-8");

      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("file-read")
            .from(file({ path: filePath }))
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(s.received).toHaveLength(1);
      expect(s.received[0].body).toBe(content);
    });

    /**
     * @case Reads file with custom encoding
     * @preconditions File with specific encoding
     * @expectedResult Content is correctly decoded
     */
    test("reads file with custom encoding", async () => {
      const filePath = path.join(tmpDir, "encoded.txt");
      const content = "Custom encoding test";
      await fsp.writeFile(filePath, content, "utf-8");

      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("file-read-encoding")
            .from(file({ path: filePath, encoding: "utf-8" }))
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(s.received[0].body).toBe(content);
    });

    /**
     * @case Throws error when file not found
     * @preconditions File path points to non-existent file
     * @expectedResult Error with "file not found" message
     */
    test("throws error when file not found", async () => {
      const filePath = path.join(tmpDir, "nonexistent.txt");

      t = await testContext()
        .routes(
          craft()
            .id("file-not-found")
            .from(file({ path: filePath }))
            .to(spy()),
        )
        .build();

      const errSpy = vi.fn();
      t.ctx.on("context:error", errSpy);
      await t.ctx.start();
      await new Promise((r) => setTimeout(r, 0));
      expect(errSpy).toHaveBeenCalled();
      const errorPayload = errSpy.mock.calls[0][0];
      const error = errorPayload.details.error;
      expect(error.message).toMatch(/file not found/);
    });

    /**
     * @case Throws error when path is function in source mode
     * @preconditions Source adapter with function path
     * @expectedResult Error indicating dynamic paths only for destinations
     */
    test("throws error when path is function in source mode", async () => {
      const adapter = createFileAdapter({ path: () => "dynamic.txt" });

      await expect(
        adapter.subscribe(
          {} as any,
          async () => ({}) as any,
          new AbortController(),
        ),
      ).rejects.toThrow(
        /path must be a string for source mode.*dynamic paths are only supported for destinations/,
      );
    });
  });

  describe("destination mode - writing files", () => {
    /**
     * @case Writes string body to file
     * @preconditions Exchange has string body
     * @expectedResult File is created with body content
     */
    test("writes string body to file", async () => {
      const filePath = path.join(tmpDir, "output.txt");
      const content = "Test output";

      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("file-write")
            .from(simple(content))
            .to(file({ path: filePath, mode: "write" }))
            .to(s),
        )
        .build();

      await t.ctx.start();

      const written = await fsp.readFile(filePath, "utf-8");
      expect(written).toBe(content);
      expect(s.received).toHaveLength(1);
    });

    /**
     * @case Writes non-string body as JSON
     * @preconditions Exchange has object body
     * @expectedResult File contains JSON.stringify'd object
     */
    test("writes non-string body as JSON", async () => {
      const filePath = path.join(tmpDir, "object.txt");
      const content = { name: "test", value: 42 };

      t = await testContext()
        .routes(
          craft()
            .id("file-write-object")
            .from(simple(content))
            .to(file({ path: filePath, mode: "write" })),
        )
        .build();

      await t.ctx.start();

      const written = await fsp.readFile(filePath, "utf-8");
      expect(JSON.parse(written)).toEqual(content);
    });

    /**
     * @case Appends to file
     * @preconditions File exists, mode is append
     * @expectedResult Content is appended to existing file
     */
    test("appends to file", async () => {
      const filePath = path.join(tmpDir, "append.txt");
      const initial = "Line 1\n";
      const appended = "Line 2\n";

      await fsp.writeFile(filePath, initial, "utf-8");

      t = await testContext()
        .routes(
          craft()
            .id("file-append")
            .from(simple(appended))
            .to(file({ path: filePath, mode: "append" })),
        )
        .build();

      await t.ctx.start();

      const written = await fsp.readFile(filePath, "utf-8");
      expect(written).toBe(initial + appended);
    });

    /**
     * @case Creates parent directories when createDirs is true
     * @preconditions Parent directory doesn't exist, createDirs is true
     * @expectedResult Parent directory is created, file is written
     */
    test("creates parent directories when createDirs is true", async () => {
      const filePath = path.join(tmpDir, "nested", "deep", "output.txt");
      const content = "Nested file";

      t = await testContext()
        .routes(
          craft()
            .id("file-create-dirs")
            .from(simple(content))
            .to(file({ path: filePath, mode: "write", createDirs: true })),
        )
        .build();

      await t.ctx.start();

      const written = await fsp.readFile(filePath, "utf-8");
      expect(written).toBe(content);
    });

    /**
     * @case Throws error when parent directory doesn't exist and createDirs is false
     * @preconditions Parent directory doesn't exist, createDirs is false
     * @expectedResult Error with "directory not found" message
     */
    test("throws error when directory doesn't exist and createDirs is false", async () => {
      const filePath = path.join(tmpDir, "nonexistent", "output.txt");
      const content = "Test";

      t = await testContext()
        .routes(
          craft()
            .id("file-no-create-dirs")
            .from(simple(content))
            .to(file({ path: filePath, mode: "write", createDirs: false })),
        )
        .build();

      const errSpy = vi.fn();
      t.ctx.on("context:error", errSpy);
      await t.ctx.start();
      await new Promise((r) => setTimeout(r, 0));
      expect(errSpy).toHaveBeenCalled();
      const errorPayload = errSpy.mock.calls[0][0];
      const error = errorPayload.details.error;
      expect(error.message).toMatch(
        /directory not found.*use createDirs: true/,
      );
    });

    /**
     * @case Supports dynamic path based on exchange
     * @preconditions Path is function that uses exchange.body
     * @expectedResult File is written at dynamically determined path
     */
    test("supports dynamic path based on exchange", async () => {
      const content = { id: "123", data: "test data" };

      t = await testContext()
        .routes(
          craft()
            .id("file-dynamic-path")
            .from(simple(content))
            .to(
              file({
                path: (ex) =>
                  path.join(
                    tmpDir,
                    `output-${(ex.body as { id: string }).id}.txt`,
                  ),
                mode: "write",
              }),
            ),
        )
        .build();

      await t.ctx.start();

      const filePath = path.join(tmpDir, "output-123.txt");
      const written = await fsp.readFile(filePath, "utf-8");
      expect(JSON.parse(written)).toEqual(content);
    });

    /**
     * @case Dynamic path with createDirs creates nested directories
     * @preconditions Dynamic path returns nested path, createDirs is true
     * @expectedResult Nested directories are created, file is written
     */
    test("dynamic path with createDirs creates nested directories", async () => {
      const content = { date: "2024-01", value: "test" };

      t = await testContext()
        .routes(
          craft()
            .id("file-dynamic-nested")
            .from(simple(content))
            .to(
              file({
                path: (ex) =>
                  path.join(
                    tmpDir,
                    "data",
                    (ex.body as { date: string }).date,
                    "output.txt",
                  ),
                mode: "write",
                createDirs: true,
              }),
            ),
        )
        .build();

      await t.ctx.start();

      const filePath = path.join(tmpDir, "data", "2024-01", "output.txt");
      const written = await fsp.readFile(filePath, "utf-8");
      expect(JSON.parse(written)).toEqual(content);
    });

    /**
     * @case Body is unchanged after destination (returns void)
     * @preconditions File destination returns void
     * @expectedResult Exchange body remains the same
     */
    test("body is unchanged after destination (returns void)", async () => {
      const filePath = path.join(tmpDir, "output.txt");
      const content = "Test content";
      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("file-no-body-change")
            .from(simple(content))
            .to(file({ path: filePath, mode: "write" }))
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(s.received[0].body).toBe(content);
    });
  });

  describe("adapterId", () => {
    /**
     * @case Adapter has correct adapterId
     * @preconditions FileAdapter instance created
     * @expectedResult adapterId is "routecraft.adapter.file"
     */
    test("has correct adapterId", () => {
      const adapter = createFileAdapter({ path: "test.txt" });
      expect(adapter.adapterId).toBe("routecraft.adapter.file");
    });
  });
});
