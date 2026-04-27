import { describe, test, expect, afterEach, beforeEach } from "vitest";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import { craft, csv, HeadersKeys } from "@routecraft/routecraft";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

describe("CSV Adapter - Chunked Mode", () => {
  let t: TestContext | undefined;
  let tmpDir: string;

  beforeEach(async () => {
    t = undefined;
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "csv-chunked-test-"));
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

  /**
   * @case Default 'fail' mode routes per-row parse errors through .error() and continues
   * @preconditions CSV chunked mode with a row Papa flags as malformed
   * @expectedResult error handler invoked with RC5016, valid rows still reach the spy
   */
  test("default 'fail' routes per-row parse errors through .error() and continues", async () => {
    const filePath = path.join(tmpDir, "mixed.csv");
    // Mismatched column counts force PapaParse to flag a row error.
    await fsp.writeFile(filePath, "a,b,c\n1,2,3\n4,5\n6,7,8\n", "utf-8");

    const s = spy();
    const errors: unknown[] = [];

    t = await testContext()
      .routes(
        craft()
          .id("csv-chunked-fail")
          .error((err) => {
            errors.push(err);
            return undefined;
          })
          .from(csv({ path: filePath, header: true, chunked: true }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect((errors[0] as { rc?: string }).rc).toBe("RC5016");
    // Two valid rows still flow through; the malformed one is caught by .error().
    expect(s.received.length).toBe(2);
  });

  /**
   * @case onParseError: 'drop' emits exchange:dropped for malformed rows
   * @preconditions CSV chunked with malformed row and onParseError: 'drop'
   * @expectedResult Only valid rows reach the spy; exchange:dropped fires with reason "parse-failed"
   */
  test("onParseError: 'drop' emits exchange:dropped for malformed rows", async () => {
    const filePath = path.join(tmpDir, "drop.csv");
    await fsp.writeFile(filePath, "a,b,c\n1,2,3\n4,5\n6,7,8\n", "utf-8");

    const s = spy();
    const dropped: { reason: string }[] = [];

    t = await testContext()
      .routes(
        craft()
          .id("csv-chunked-drop")
          .from(
            csv({
              path: filePath,
              header: true,
              chunked: true,
              onParseError: "drop",
            }),
          )
          .to(s),
      )
      .build();

    t.ctx.on(
      "route:csv-chunked-drop:exchange:dropped" as never,
      ((payload: { details: { reason: string } }) => {
        dropped.push({ reason: payload.details.reason });
      }) as never,
    );

    await t.ctx.start();

    expect(s.received.length).toBe(2);
    expect(dropped.length).toBeGreaterThanOrEqual(1);
    expect(dropped[0].reason).toBe("parse-failed");
  });
});
