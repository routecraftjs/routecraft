import {
  describe,
  test,
  expect,
  spyOn,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
} from "bun:test";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Silence logger output. Bun:test has no `importActual`/spread-and-override
// equivalent for `mock.module`, so spy on the live `logger` singleton
// directly. Pino-style loggers are mutable. Spies are installed once and
// restored after all tests so the singleton is clean for other test files.
const { logger } = await import("@routecraft/routecraft");
const runModule = await import("../src/run");

describe("CLI run command", () => {
  let cwd: string;
  let dir: string;

  let spies: Array<{ mockRestore: () => void }> = [];

  beforeAll(() => {
    spies = [
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "error").mockImplementation(() => {}),
      spyOn(logger, "debug").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
    ];
  });

  afterAll(() => {
    for (const s of spies) s.mockRestore();
    spies = [];
  });

  beforeEach(async () => {
    cwd = process.cwd();
    // Use a dir inside the package so that dynamic imports of temp files can
    // resolve workspace packages by climbing up to the root node_modules.
    dir = join(import.meta.dir, `tmp-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    process.chdir(dir);
  });

  afterEach(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * @case Verifies that unsupported file extensions are rejected
   * @preconditions A file with unsupported extension (.py)
   * @expectedResult runCommand should return failure with appropriate message
   */
  test("rejects unsupported extension", async () => {
    const { runCommand } = runModule;
    const res = await runCommand("file.py");
    expect(res.success).toBe(false);
    if ("message" in res) {
      expect(res.message).toContain("file types are supported");
    }
  });

  /**
   * @case Verifies that supported file extensions are accepted
   * @preconditions Files with supported extensions (.js, .mjs, .cjs, .ts) containing valid in-memory routes
   * @expectedResult runCommand succeeds for each extension
   */
  test("accepts supported extensions", async () => {
    const files = ["a.js", "b.mjs", "c.cjs", "d.ts"];
    for (const f of files) {
      await writeFile(
        f,
        `
        import { craft, simple, log } from "@routecraft/routecraft";
        export default craft().id("x").from(simple("y")).to(log());
      `,
      );
      const { runCommand } = runModule;
      const res = await runCommand(f);
      expect(res.success).toBe(true);
    }
  });

  /**
   * @case Verifies that files without default export fail gracefully
   * @preconditions A file with no default export
   * @expectedResult runCommand should return failure indicating missing default export
   */
  test("missing default export fails", async () => {
    await writeFile("no-default.js", "export const x = 1;");
    const { runCommand } = runModule;
    const res = await runCommand("no-default.js");
    expect(res.success).toBe(false);
    if ("message" in res) {
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
    const { runCommand } = runModule;
    const res = await runCommand("invalid.js");
    expect(res.success).toBe(false);
    if ("message" in res) {
      expect(res.message).toContain("Invalid default export");
    }
  });

  /**
   * @case Verifies that craftConfig named export is properly detected and processed
   * @preconditions A file with both craftConfig named export and valid default route export
   * @expectedResult runCommand succeeds and processes both exports
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
    const { runCommand } = runModule;
    const res = await runCommand("with-config.js");
    expect(res.success).toBe(true);
  });

  /**
   * @case Verifies that RouteBuilder instances are correctly distinguished from RouteDefinitions
   * @preconditions A file exporting a RouteBuilder instance (with .id() method)
   * @expectedResult runCommand succeeds, recognizing the RouteBuilder and calling .build()
   */
  test("RouteBuilder with .id() method is correctly identified", async () => {
    await writeFile(
      "route-builder.js",
      `
      import { craft, simple, log } from "@routecraft/routecraft";
      export default craft().id("test-route").from(simple("test")).to(log());
    `,
    );
    const { runCommand } = runModule;
    const res = await runCommand("route-builder.js");
    expect(res.success).toBe(true);
  });

  /**
   * @case Verifies that arrays of RouteBuilders are correctly processed
   * @preconditions A file exporting an array of RouteBuilder instances
   * @expectedResult runCommand succeeds, recognizing all RouteBuilders and processing them
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
    const { runCommand } = runModule;
    const res = await runCommand("route-builder-array.js");
    expect(res.success).toBe(true);
  });

  describe("with an argv() route", () => {
    /** A hand-written Standard Schema: the CLI package has no schema library. */
    const ROUTE = `
      import { craft, argv, direct } from "@routecraft/routecraft";
      const jsonSchema = {
        type: "object",
        properties: { id: { type: "string", description: "The work item id" } },
        required: ["id"],
      };
      const WorkItemQuery = {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: (value) =>
            typeof value?.id === "string"
              ? { value }
              : { issues: [{ message: "Required", path: ["id"] }] },
          jsonSchema: { input: () => jsonSchema, output: () => jsonSchema },
        },
      };
      export default craft()
        .id("work-item")
        .title("Fetch a work item")
        .input({ body: WorkItemQuery })
        .from(argv(), direct())
        .transform((body) => ({ found: body.id }));
    `;

    /** Settings read from the temp dir only, so a developer's own file cannot change the format. */
    const isolated = (env: NodeJS.ProcessEnv = {}) => ({
      cwd: dir,
      home: dir,
      env,
    });

    /**
     * @case The command line reaches the route and the process can exit
     * @preconditions An argv() route beside direct(), --format json
     * @expectedResult runCommand returns despite direct() holding the route open, with exit 0 and the route's result as JSON
     */
    test("runs the route once and returns its result", async () => {
      await writeFile("work-item.ts", ROUTE);
      const res = await runModule.runCommand(
        "work-item.ts",
        ["--id=12345", "--format", "json"],
        isolated(),
      );
      expect(res).toEqual({
        success: true,
        reply: {
          code: 0,
          output: JSON.stringify(
            { outcome: "completed", body: { found: "12345" } },
            null,
            2,
          ),
        },
      });
    });

    /**
     * @case JSON on stdin is the route's input
     * @preconditions No flags; the stdin reader yields a JSON object
     * @expectedResult Exit 0 with the raw result
     */
    test("reads the input from stdin", async () => {
      await writeFile("work-item.ts", ROUTE);
      const res = await runModule.runCommand("work-item.ts", ["--format=raw"], {
        ...isolated(),
        readStdin: () => Promise.resolve('{"id":"7"}'),
      });
      expect("reply" in res && res.reply).toEqual({
        code: 0,
        output: '{"found":"7"}',
      });
    });

    /**
     * @case An authorizing argv() route fails when nothing supplies a principal
     * @preconditions An argv() route with .authorize() and no plugin supplying an identity
     * @expectedResult Exit 1 and the step never ran
     */
    test("exits 1 for an authorizing route with no principal", async () => {
      await writeFile(
        "guarded.ts",
        `
        import { writeFileSync } from "node:fs";
        import { craft, argv } from "@routecraft/routecraft";
        export default craft()
          .id("guarded")
          .authorize({ scopes: ["boards:read"] })
          .from(argv())
          .to(() => writeFileSync("ran", ""));
      `,
      );
      const res = await runModule.runCommand(
        "guarded.ts",
        ["--id=1"],
        isolated(),
      );
      if (!("reply" in res)) throw new Error("expected a reply");
      expect(res.reply.code).toBe(1);
      expect(existsSync("ran")).toBe(false);
    });

    /**
     * @case An .input() failure exits 2 with the schema message
     * @preconditions The required id field is missing
     * @expectedResult Exit 2 with the failing path in the message
     */
    test("exits 2 when the input fails the schema", async () => {
      await writeFile("work-item.ts", ROUTE);
      const res = await runModule.runCommand(
        "work-item.ts",
        ["--other=1"],
        isolated(),
      );
      expect(res.success).toBe(false);
      if (!("reply" in res)) throw new Error("expected a reply");
      expect(res.reply.code).toBe(2);
      expect(res.reply.error).toMatch(/- id:/);
    });

    /**
     * @case --help renders the input schema
     * @preconditions --help after the file
     * @expectedResult Exit 0 and a help text listing the id field as required with its description
     */
    test("prints the input fields for --help", async () => {
      await writeFile("work-item.ts", ROUTE);
      const res = await runModule.runCommand(
        "work-item.ts",
        ["--help"],
        isolated(),
      );
      if (!("reply" in res)) throw new Error("expected a reply");
      expect(res.reply.code).toBe(0);
      expect(res.reply.output).toMatch(/Route: work-item/);
      expect(res.reply.output).toMatch(
        /--id\s+string\s+yes\s+The work item id/,
      );
    });

    /**
     * @case Two argv() routes in one file are refused before anything runs
     * @preconditions A file exporting two routes that both read argv(), each writing a marker when it runs
     * @expectedResult A usage failure (exit 2) naming both routes, and no marker
     */
    test("refuses a file with two argv() routes before starting", async () => {
      await writeFile(
        "two.ts",
        `
        import { writeFileSync } from "node:fs";
        import { craft, argv } from "@routecraft/routecraft";
        export default [
          craft().id("a").from(argv()).to(() => writeFileSync("ran-a", "")),
          craft().id("b").from(argv()).to(() => writeFileSync("ran-b", "")),
        ];
      `,
      );
      const res = await runModule.runCommand("two.ts", ["--x=1"], isolated());
      expect(res).toMatchObject({ success: false, code: 2 });
      if ("message" in res) expect(res.message).toMatch(/"a", "b"/);
      expect(existsSync("ran-a") || existsSync("ran-b")).toBe(false);
    });

    /**
     * @case A file with no argv() route does not read the settings file
     * @preconditions An invalid CRAFT_URL, which only exec-family commands use, and a file with no argv() route
     * @expectedResult The run succeeds, because craft run resolves settings only for an argv() route
     */
    test("ignores exec-only settings for a file with no argv() route", async () => {
      await writeFile(
        "plain.ts",
        `
        import { craft, simple, noop } from "@routecraft/routecraft";
        export default craft().id("plain").from(simple("x")).to(noop());
      `,
      );
      const res = await runModule.runCommand(
        "plain.ts",
        [],
        isolated({ CRAFT_URL: "not a url" }),
      );
      expect(res).toEqual({ success: true });
    });

    /**
     * @case --format without a value is a usage error before anything loads
     * @preconditions --format as the last argument
     * @expectedResult A failure with exit 2
     */
    test("refuses --format without a value", async () => {
      await writeFile("work-item.ts", ROUTE);
      const res = await runModule.runCommand(
        "work-item.ts",
        ["--format"],
        isolated(),
      );
      expect(res).toEqual({
        success: false,
        code: 2,
        message: "--format needs a value: pretty, json, or raw.",
      });
    });
  });

  // Runtime execution of .ts files relies on Node's type stripping (22.6+ flag, 23.6+ default).
  // The re-exec logic lives in index.ts. run.ts only validates the extension.

  /**
   * Manual test for "two-copy" duck-typing (different CLI vs route package):
   * 1. From repo root: bun run build
   * 2. Run: npx @routecraft/cli@canary run examples/index.mjs
   * The CLI uses its own @routecraft/routecraft; the loaded file resolves to the
   * workspace package, so RouteBuilder is from a different copy. With duck-typing
   * the server should start; without it you get "Route definition failed validation: id(e){return..."
   */
});
