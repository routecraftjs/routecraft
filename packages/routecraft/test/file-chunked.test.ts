import { describe, test, expect, afterEach, beforeEach } from "vitest";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import { craft, file, HeadersKeys } from "@routecraft/routecraft";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

describe("File Adapter - Chunked Mode", () => {
  let t: TestContext;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "file-chunked-test-"));
  });

  afterEach(async () => {
    if (t) await t.stop();
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  /**
   * @case Emits one exchange per line in chunked mode
   * @preconditions File with 3 lines exists
   * @expectedResult 3 separate exchanges are emitted, one per line
   */
  test("emits one exchange per line", async () => {
    const filePath = path.join(tmpDir, "lines.txt");
    await fsp.writeFile(filePath, "line1\nline2\nline3", "utf-8");

    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("file-chunked")
          .from(file({ path: filePath, chunked: true }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(3);
    expect(s.received[0].body).toBe("line1");
    expect(s.received[1].body).toBe("line2");
    expect(s.received[2].body).toBe("line3");
  });

  /**
   * @case Includes FILE_LINE and FILE_PATH headers
   * @preconditions File with 2 lines exists
   * @expectedResult Each exchange has correct line number and file path headers
   */
  test("includes FILE_LINE and FILE_PATH headers", async () => {
    const filePath = path.join(tmpDir, "headers.txt");
    await fsp.writeFile(filePath, "alpha\nbeta", "utf-8");

    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("file-chunked-headers")
          .from(file({ path: filePath, chunked: true }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(2);
    expect(s.received[0].headers[HeadersKeys.FILE_LINE]).toBe(1);
    expect(s.received[0].headers[HeadersKeys.FILE_PATH]).toBe(filePath);
    expect(s.received[1].headers[HeadersKeys.FILE_LINE]).toBe(2);
    expect(s.received[1].headers[HeadersKeys.FILE_PATH]).toBe(filePath);
  });

  /**
   * @case Abort mid-stream stops emitting
   * @preconditions File with many lines, abort after first exchange
   * @expectedResult Fewer exchanges than total lines
   */
  test("abort mid-stream stops emitting", async () => {
    const filePath = path.join(tmpDir, "many.txt");
    const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`);
    await fsp.writeFile(filePath, lines.join("\n"), "utf-8");

    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("file-chunked-abort")
          .from(file({ path: filePath, chunked: true }))
          .process(async (exchange) => {
            // Abort after processing 3 exchanges
            if (s.received.length >= 2) {
              t.ctx.stop();
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
   * @case Non-chunked mode still works (regression)
   * @preconditions File with multiple lines, chunked not set
   * @expectedResult Single exchange with full file content
   */
  test("non-chunked mode still works (regression)", async () => {
    const filePath = path.join(tmpDir, "whole.txt");
    const content = "line1\nline2\nline3";
    await fsp.writeFile(filePath, content, "utf-8");

    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("file-non-chunked")
          .from(file({ path: filePath }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    expect(s.received[0].body).toBe(content);
  });

  /**
   * @case Handles empty file in chunked mode
   * @preconditions Empty file exists
   * @expectedResult No exchanges emitted
   */
  test("handles empty file in chunked mode", async () => {
    const filePath = path.join(tmpDir, "empty.txt");
    await fsp.writeFile(filePath, "", "utf-8");

    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("file-chunked-empty")
          .from(file({ path: filePath, chunked: true }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(0);
  });

  /**
   * @case Throws error for non-existent file in chunked mode
   * @preconditions File path points to non-existent file
   * @expectedResult Error with "file not found" message
   */
  test("throws error for non-existent file in chunked mode", async () => {
    const filePath = path.join(tmpDir, "nonexistent.txt");

    const adapter = file({ path: filePath, chunked: true });

    await expect(
      adapter.subscribe(
        {} as any,
        async () => ({}) as any,
        new AbortController(),
      ),
    ).rejects.toThrow(/file not found/);
  });
});
