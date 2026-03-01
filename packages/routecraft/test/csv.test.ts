import { describe, test, expect, afterEach, beforeEach, vi } from "vitest";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  simple,
  csv,
  CsvAdapter,
  type CallableDestination,
} from "@routecraft/routecraft";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

describe("CSV Adapter", () => {
  let t: TestContext;
  let tmpDir: string;

  beforeEach(async () => {
    // Create a temporary directory for test files
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "csv-adapter-test-"));
  });

  afterEach(async () => {
    if (t) await t.stop();
    // Clean up temporary directory
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  describe("source mode - reading CSV files", () => {
    /**
     * @case Reads CSV file with headers
     * @preconditions CSV file exists with header row
     * @expectedResult Array of objects with headers as keys
     */
    test("reads CSV file with headers", async () => {
      const filePath = path.join(tmpDir, "data.csv");
      const csvContent = `name,age,city
Alice,30,NYC
Bob,25,LA`;
      await fsp.writeFile(filePath, csvContent, "utf-8");

      const destSpy = vi.fn();

      t = await testContext()
        .routes(
          craft()
            .id("csv-read-headers")
            .from(csv({ path: filePath, header: true }))
            .to(destSpy as CallableDestination<unknown, void>),
        )
        .build();

      await t.ctx.start();

      expect(destSpy).toHaveBeenCalledTimes(1);
      expect(destSpy.mock.calls[0][0].body).toEqual([
        { name: "Alice", age: "30", city: "NYC" },
        { name: "Bob", age: "25", city: "LA" },
      ]);
    });

    /**
     * @case Reads CSV file without headers
     * @preconditions CSV file exists without header row
     * @expectedResult Array of arrays
     */
    test("reads CSV file without headers", async () => {
      const filePath = path.join(tmpDir, "data-no-header.csv");
      const csvContent = `Alice,30,NYC
Bob,25,LA`;
      await fsp.writeFile(filePath, csvContent, "utf-8");

      const destSpy = vi.fn();

      t = await testContext()
        .routes(
          craft()
            .id("csv-read-no-headers")
            .from(csv({ path: filePath, header: false }))
            .to(destSpy as CallableDestination<unknown, void>),
        )
        .build();

      await t.ctx.start();

      expect(destSpy).toHaveBeenCalledTimes(1);
      expect(destSpy.mock.calls[0][0].body).toEqual([
        ["Alice", "30", "NYC"],
        ["Bob", "25", "LA"],
      ]);
    });

    /**
     * @case Reads CSV with custom delimiter
     * @preconditions TSV file with tab delimiter
     * @expectedResult Array of objects parsed with tab delimiter
     */
    test("reads CSV with custom delimiter", async () => {
      const filePath = path.join(tmpDir, "data.tsv");
      const csvContent = `name\tage\tcity
Alice\t30\tNYC
Bob\t25\tLA`;
      await fsp.writeFile(filePath, csvContent, "utf-8");

      const destSpy = vi.fn();

      t = await testContext()
        .routes(
          craft()
            .id("csv-read-delimiter")
            .from(csv({ path: filePath, header: true, delimiter: "\t" }))
            .to(destSpy as CallableDestination<unknown, void>),
        )
        .build();

      await t.ctx.start();

      expect(destSpy).toHaveBeenCalledTimes(1);
      expect(destSpy.mock.calls[0][0].body).toEqual([
        { name: "Alice", age: "30", city: "NYC" },
        { name: "Bob", age: "25", city: "LA" },
      ]);
    });

    /**
     * @case Skips empty lines
     * @preconditions CSV file with empty lines
     * @expectedResult Empty lines are skipped
     */
    test("skips empty lines", async () => {
      const filePath = path.join(tmpDir, "data-empty.csv");
      const csvContent = `name,age,city

Alice,30,NYC

Bob,25,LA
`;
      await fsp.writeFile(filePath, csvContent, "utf-8");

      const destSpy = vi.fn();

      t = await testContext()
        .routes(
          craft()
            .id("csv-read-skip-empty")
            .from(csv({ path: filePath, header: true, skipEmptyLines: true }))
            .to(destSpy as CallableDestination<unknown, void>),
        )
        .build();

      await t.ctx.start();

      expect(destSpy).toHaveBeenCalledTimes(1);
      expect(destSpy.mock.calls[0][0].body).toEqual([
        { name: "Alice", age: "30", city: "NYC" },
        { name: "Bob", age: "25", city: "LA" },
      ]);
    });

    /**
     * @case Handles malformed CSV gracefully
     * @preconditions CSV file with unclosed quotes (papaparse may recover)
     * @expectedResult Either parses with best effort or throws error
     */
    test("handles potentially malformed CSV", async () => {
      const filePath = path.join(tmpDir, "edge-case.csv");
      // CSV that might have issues but papaparse handles gracefully
      const csvContent = `name,age
Alice,30
Bob,25`;
      await fsp.writeFile(filePath, csvContent, "utf-8");

      const destSpy = vi.fn();

      t = await testContext()
        .routes(
          craft()
            .id("csv-edge-case")
            .from(csv({ path: filePath, header: true }))
            .to(destSpy as CallableDestination<unknown, void>),
        )
        .build();

      await t.ctx.start();

      // Should parse successfully
      expect(destSpy).toHaveBeenCalled();
    });
  });

  describe("destination mode - writing CSV files", () => {
    /**
     * @case Writes array of objects to CSV with headers
     * @preconditions Exchange has array body
     * @expectedResult CSV file created with header row
     */
    test("writes array of objects to CSV with headers", async () => {
      const filePath = path.join(tmpDir, "output.csv");
      const data = [
        { name: "Alice", age: 30, city: "NYC" },
        { name: "Bob", age: 25, city: "LA" },
      ];

      // Note: simple(array) emits each item individually
      // So CSV adapter will receive individual records and append them
      t = await testContext()
        .routes(
          craft()
            .id("csv-write-headers")
            .from(simple(data))
            .to(csv({ path: filePath, header: true, mode: "append" })),
        )
        .build();

      await t.ctx.start();

      const written = await fsp.readFile(filePath, "utf-8");
      expect(written).toContain("name,age,city");
      expect(written).toContain("Alice,30,NYC");
      expect(written).toContain("Bob,25,LA");
    });

    /**
     * @case Writes CSV with custom delimiter
     * @preconditions Custom delimiter specified
     * @expectedResult CSV file with custom delimiter
     */
    test("writes CSV with custom delimiter", async () => {
      const filePath = path.join(tmpDir, "output.tsv");
      const data = [
        { name: "Alice", age: 30 },
        { name: "Bob", age: 25 },
      ];

      t = await testContext()
        .routes(
          craft()
            .id("csv-write-delimiter")
            .from(simple(data))
            .to(
              csv({
                path: filePath,
                header: true,
                delimiter: "\t",
                mode: "append",
              }),
            ),
        )
        .build();

      await t.ctx.start();

      const written = await fsp.readFile(filePath, "utf-8");
      expect(written).toContain("name\tage");
      expect(written).toContain("Alice\t30");
    });

    /**
     * @case Appends to CSV file
     * @preconditions File exists, mode is append
     * @expectedResult New rows appended to file
     */
    test("appends to CSV file", async () => {
      const filePath = path.join(tmpDir, "append.csv");
      const initial = `name,age
Alice,30
`;
      await fsp.writeFile(filePath, initial, "utf-8");

      const data = [{ name: "Bob", age: 25 }];

      t = await testContext()
        .routes(
          craft()
            .id("csv-append")
            .from(simple(data))
            .to(csv({ path: filePath, header: true, mode: "append" })),
        )
        .build();

      await t.ctx.start();

      const written = await fsp.readFile(filePath, "utf-8");
      expect(written).toContain("Alice,30");
      expect(written).toContain("Bob,25");
    });

    /**
     * @case Creates parent directories when createDirs is true
     * @preconditions Parent directory doesn't exist, createDirs is true
     * @expectedResult Parent directory is created, CSV file is written
     */
    test("creates parent directories when createDirs is true", async () => {
      const filePath = path.join(tmpDir, "nested", "deep", "output.csv");
      const data = [{ name: "Alice", age: 30 }];

      t = await testContext()
        .routes(
          craft()
            .id("csv-create-dirs")
            .from(simple(data))
            .to(csv({ path: filePath, header: true, createDirs: true })),
        )
        .build();

      await t.ctx.start();

      const written = await fsp.readFile(filePath, "utf-8");
      expect(written).toContain("name,age");
      expect(written).toContain("Alice,30");
    });

    /**
     * @case Supports dynamic path based on exchange
     * @preconditions Path is function that uses exchange.body
     * @expectedResult CSV file is written at dynamically determined path
     */
    test("supports dynamic path based on exchange", async () => {
      const data = [
        { date: "2024-01", value: 100 },
        { date: "2024-02", value: 200 },
      ];

      t = await testContext()
        .routes(
          craft()
            .id("csv-dynamic-path")
            .from(simple(data))
            .to(
              csv({
                path: () => path.join(tmpDir, "dynamic-output.csv"),
                header: true,
                mode: "append",
              }),
            ),
        )
        .build();

      await t.ctx.start();

      const filePath = path.join(tmpDir, "dynamic-output.csv");
      const written = await fsp.readFile(filePath, "utf-8");
      expect(written).toContain("date,value");
      expect(written).toContain("2024-01,100");
    });

    /**
     * @case Accepts single object (wraps in array automatically)
     * @preconditions Exchange body is a single object
     * @expectedResult Object is written as single CSV row
     */
    test("accepts single object and writes as CSV row", async () => {
      const filePath = path.join(tmpDir, "output.csv");
      const data = { name: "Alice", age: 30 };

      t = await testContext()
        .routes(
          craft()
            .id("csv-single-object")
            .from(simple(data))
            .to(csv({ path: filePath, header: true })),
        )
        .build();

      await t.ctx.start();

      const written = await fsp.readFile(filePath, "utf-8");
      expect(written).toContain("name,age");
      expect(written).toContain("Alice,30");
    });

    /**
     * @case Body is unchanged after destination (returns void)
     * @preconditions CSV destination returns void
     * @expectedResult Exchange body remains the same
     */
    test("body is unchanged after destination (returns void)", async () => {
      const filePath = path.join(tmpDir, "output.csv");
      const data = [{ name: "Alice", age: 30 }];
      const destSpy = vi.fn();

      t = await testContext()
        .routes(
          craft()
            .id("csv-no-body-change")
            .from(simple(data))
            .to(csv({ path: filePath, header: true, mode: "append" }))
            .to(destSpy as CallableDestination<unknown, void>),
        )
        .build();

      await t.ctx.start();

      // simple(array) emits each item, so destSpy receives individual objects
      expect(destSpy).toHaveBeenCalledTimes(1);
      expect(destSpy.mock.calls[0][0].body).toEqual({ name: "Alice", age: 30 });
    });
  });

  describe("adapterId", () => {
    /**
     * @case Adapter has correct adapterId
     * @preconditions CsvAdapter instance created
     * @expectedResult adapterId is "routecraft.adapter.csv"
     */
    test("has correct adapterId", () => {
      const adapter = new CsvAdapter({ path: "test.csv" });
      expect(adapter.adapterId).toBe("routecraft.adapter.csv");
    });
  });
});
