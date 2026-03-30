import { describe, test, expect, afterEach, beforeEach } from "vitest";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import { craft, csv, HeadersKeys } from "@routecraft/routecraft";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

describe("CSV Adapter - Chunked Mode", () => {
  let t: TestContext;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "csv-chunked-test-"));
  });

  afterEach(async () => {
    if (t) await t.stop();
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  /**
   * @case Emits one exchange per row with headers
   * @preconditions CSV file with header row and 2 data rows
   * @expectedResult 2 exchanges emitted, each as an object keyed by header
   */
  test("emits one exchange per row with headers", async () => {
    const filePath = path.join(tmpDir, "data.csv");
    await fsp.writeFile(
      filePath,
      "name,age,city\nAlice,30,NYC\nBob,25,LA",
      "utf-8",
    );

    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("csv-chunked-headers")
          .from(csv({ path: filePath, header: true, chunked: true }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(2);
    expect(s.received[0].body).toEqual({
      name: "Alice",
      age: "30",
      city: "NYC",
    });
    expect(s.received[1].body).toEqual({
      name: "Bob",
      age: "25",
      city: "LA",
    });
  });

  /**
   * @case Emits one exchange per row without headers
   * @preconditions CSV file without header row
   * @expectedResult Each exchange body is a string array
   */
  test("emits one exchange per row without headers", async () => {
    const filePath = path.join(tmpDir, "no-header.csv");
    await fsp.writeFile(filePath, "Alice,30,NYC\nBob,25,LA", "utf-8");

    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("csv-chunked-no-headers")
          .from(csv({ path: filePath, header: false, chunked: true }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(2);
    expect(s.received[0].body).toEqual(["Alice", "30", "NYC"]);
    expect(s.received[1].body).toEqual(["Bob", "25", "LA"]);
  });

  /**
   * @case Includes CSV_ROW and CSV_PATH headers
   * @preconditions CSV file with 2 data rows
   * @expectedResult Each exchange has correct row number and path headers
   */
  test("includes CSV_ROW and CSV_PATH headers", async () => {
    const filePath = path.join(tmpDir, "headers.csv");
    await fsp.writeFile(filePath, "name\nAlice\nBob", "utf-8");

    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("csv-chunked-meta-headers")
          .from(csv({ path: filePath, header: true, chunked: true }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(2);
    expect(s.received[0].headers[HeadersKeys.CSV_ROW]).toBe(1);
    expect(s.received[0].headers[HeadersKeys.CSV_PATH]).toBe(filePath);
    expect(s.received[1].headers[HeadersKeys.CSV_ROW]).toBe(2);
  });

  /**
   * @case Chunked mode correctly emits rows from valid CSV
   * @preconditions CSV with header and data rows, chunked mode
   * @expectedResult All data rows emitted as individual exchanges
   */
  test("emits all rows from valid CSV in chunked mode", async () => {
    const filePath = path.join(tmpDir, "valid.csv");
    await fsp.writeFile(filePath, "name\nAlice\nBob\nCarol", "utf-8");

    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("csv-chunked-valid")
          .from(csv({ path: filePath, header: true, chunked: true }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(3);
    expect(s.received[0].body).toEqual({ name: "Alice" });
    expect(s.received[1].body).toEqual({ name: "Bob" });
    expect(s.received[2].body).toEqual({ name: "Carol" });
  });

  /**
   * @case Non-chunked mode still works (regression)
   * @preconditions CSV file, chunked not set
   * @expectedResult Single exchange with full parsed array
   */
  test("non-chunked mode still works (regression)", async () => {
    const filePath = path.join(tmpDir, "whole.csv");
    await fsp.writeFile(filePath, "name,age\nAlice,30\nBob,25", "utf-8");

    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("csv-non-chunked")
          .from(csv({ path: filePath, header: true }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    expect(s.received[0].body).toEqual([
      { name: "Alice", age: "30" },
      { name: "Bob", age: "25" },
    ]);
  });

  /**
   * @case Abort mid-stream stops emitting
   * @preconditions CSV with many rows, abort signal triggered after a few
   * @expectedResult Fewer exchanges than total rows
   */
  test("abort mid-stream stops emitting", async () => {
    const filePath = path.join(tmpDir, "many.csv");
    const rows = ["name"];
    for (let i = 0; i < 50; i++) {
      rows.push(`person${i}`);
    }
    await fsp.writeFile(filePath, rows.join("\n"), "utf-8");

    const received: unknown[] = [];
    const abortController = new AbortController();
    const adapter = csv({ path: filePath, header: true, chunked: true });

    await adapter.subscribe(
      {} as any,
      async (row) => {
        received.push(row);
        if (received.length >= 3) {
          abortController.abort();
        }
        return {} as any;
      },
      abortController,
    );

    expect(received.length).toBeGreaterThanOrEqual(3);
    expect(received.length).toBeLessThan(50);
  }, 10000);
});
