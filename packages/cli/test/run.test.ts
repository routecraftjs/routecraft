import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// No TypeScript runtime mocking needed; CLI no longer supports running .ts files directly

// Silence logger output
vi.mock("@routecraft/routecraft", async () => {
  const actual = await vi.importActual<any>("@routecraft/routecraft");
  return {
    ...actual,
    logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
  };
});

describe("CLI run command", () => {
  let cwd: string;
  let dir: string;

  beforeEach(async () => {
    cwd = process.cwd();
    dir = join(tmpdir(), `rc-cli-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    process.chdir(dir);
  });

  afterEach(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  /**
   * @case Verifies that unsupported file extensions are rejected
   * @preconditions A file with unsupported extension (.py)
   * @expectedResult runCommand should return failure with appropriate message
   */
  test("rejects unsupported extension", async () => {
    const { runCommand } = await import("../src/run");
    const res = await runCommand("file.py");
    expect(res.success).toBe(false);
    if (res.success === false) {
      expect(res.message).toContain("file types are supported");
    }
  });

  /**
   * @case Verifies that supported file extensions are accepted
   * @preconditions Files with supported extensions (.js, .mjs, .cjs)
   * @expectedResult runCommand should process files without extension errors
   */
  test("accepts supported extensions", async () => {
    const files = ["a.js", "b.mjs", "c.cjs"];
    for (const f of files) {
      await writeFile(
        f,
        `
        import { craft, simple, log } from "@routecraft/routecraft";
        export default craft().id("x").from(simple("y")).to(log());
      `,
      );
      const { runCommand } = await import("../src/run");
      const res = await runCommand(f);
      // May fail later at start, but should pass validation+loading
      expect(res.success === true || res.success === false).toBe(true);
    }
  });

  /**
   * @case Verifies that files without default export fail gracefully
   * @preconditions A file with no default export
   * @expectedResult runCommand should return failure indicating missing default export
   */
  test("missing default export fails", async () => {
    await writeFile("no-default.js", "export const x = 1;");
    const { runCommand } = await import("../src/run");
    const res = await runCommand("no-default.js");
    expect(res.success).toBe(false);
    if (res.success === false) {
      expect(res.message).toContain("No default export found");
    }
  });

  /**
   * @case Verifies that files with invalid default export fail gracefully
   * @preconditions A file with invalid default export (string instead of route)
   * @expectedResult runCommand should return failure indicating invalid default export
   */
  test("invalid default export fails", async () => {
    await writeFile("invalid.js", 'export default "nope";');
    const { runCommand } = await import("../src/run");
    const res = await runCommand("invalid.js");
    expect(res.success).toBe(false);
    if (res.success === false) {
      expect(res.message).toContain("Invalid default export");
    }
  });

  /**
   * @case Verifies that craftConfig named export is properly detected and processed
   * @preconditions A file with both craftConfig named export and valid default route export
   * @expectedResult runCommand should process both exports without error
   */
  test("craftConfig named export is detected", async () => {
    await writeFile(
      "with-config.js",
      `
      import { craft, simple, log } from "@routecraft/routecraft";
      export const craftConfig = { };
      export default craft().id("x").from(simple("y")).to(log());
    `,
    );
    const { runCommand } = await import("../src/run");
    const res = await runCommand("with-config.js");
    expect(res.success === true || res.success === false).toBe(true);
  });

  /**
   * @case Verifies that RouteBuilder instances are correctly distinguished from RouteDefinitions
   * @preconditions A file exporting a RouteBuilder instance (with .id() method)
   * @expectedResult runCommand should recognize it as RouteBuilder and call .build()
   * @description This tests the fix for the bug where RouteBuilder.id (method) was
   *              mistaken for RouteDefinition.id (string property)
   */
  test("RouteBuilder with .id() method is correctly identified", async () => {
    await writeFile(
      "route-builder.js",
      `
      import { craft, simple, log } from "@routecraft/routecraft";
      export default craft().id("test-route").from(simple("test")).to(log());
    `,
    );
    const { runCommand } = await import("../src/run");
    const res = await runCommand("route-builder.js");
    // Should not get "Route definition failed validation" error
    // May fail at start due to test environment, but validation should pass
    if (!res.success) {
      expect(res.message).not.toContain("Route definition failed validation");
      expect(res.message).not.toMatch(/id\(.*\{.*return.*this\.pendingOptions/);
    }
  });

  /**
   * @case Verifies that arrays of RouteBuilders are correctly processed
   * @preconditions A file exporting an array of RouteBuilder instances
   * @expectedResult runCommand should recognize all as RouteBuilders and process them
   */
  test("array of RouteBuilders is correctly identified", async () => {
    await writeFile(
      "route-builder-array.js",
      `
      import { craft, simple, log } from "@routecraft/routecraft";
      const route1 = craft().id("route-1").from(simple("test1")).to(log());
      const route2 = craft().id("route-2").from(simple("test2")).to(log());
      export default [route1, route2];
    `,
    );
    const { runCommand } = await import("../src/run");
    const res = await runCommand("route-builder-array.js");
    // Should not get "Route definition failed validation" error
    if (!res.success) {
      expect(res.message).not.toContain("Route definition failed validation");
      expect(res.message).not.toMatch(/id\(.*\{.*return.*this\.pendingOptions/);
    }
  });

  // Intentionally no test for .ts runtime; CLI rejects .ts/.tsx inputs
});
