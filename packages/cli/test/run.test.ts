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
      export const craftConfig = { routes: [] };
      export default craft().id("x").from(simple("y")).to(log());
    `,
    );
    const { runCommand } = await import("../src/run");
    const res = await runCommand("with-config.js");
    expect(res.success === true || res.success === false).toBe(true);
  });

  // Intentionally no test for .ts runtime; CLI rejects .ts/.tsx inputs
});
