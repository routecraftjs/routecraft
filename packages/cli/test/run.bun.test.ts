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
// equivalent for `mock.module`, so spy on the live default logger
// directly. Pino-style loggers are mutable. Spies are installed once and
// restored after all tests so the logger is clean for other test files.
const { defaultLogger } = await import("@routecraft/routecraft");
const logger = defaultLogger();
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
    expect(res).toMatchObject({ success: false });
    if (!("message" in res)) throw new Error("expected a failure");
    expect(res.message).toContain("file types are supported");
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
        import { craft, simple, noop } from "@routecraft/routecraft";
        export default craft().id("x").from(simple("y")).to(noop());
      `,
      );
      const { runCommand } = runModule;
      const res = await runCommand(f);
      expect(res).toEqual({ success: true });
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
    expect(res).toMatchObject({ success: false });
    if (!("message" in res)) throw new Error("expected a failure");
    expect(res.message).toContain("No default export found");
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
    expect(res).toMatchObject({ success: false });
    if (!("message" in res)) throw new Error("expected a failure");
    expect(res.message).toContain("Invalid default export");
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
      import { craft, simple, noop } from "@routecraft/routecraft";
      export const craftConfig = { };
      export default craft().id("x").from(simple("y")).to(noop());
    `,
    );
    const { runCommand } = runModule;
    const res = await runCommand("with-config.js");
    expect(res).toEqual({ success: true });
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
      import { craft, simple, noop } from "@routecraft/routecraft";
      export default craft().id("test-route").from(simple("test")).to(noop());
    `,
    );
    const { runCommand } = runModule;
    const res = await runCommand("route-builder.js");
    expect(res).toEqual({ success: true });
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
      import { craft, simple, noop } from "@routecraft/routecraft";
      const route1 = craft().id("route-1").from(simple("test1")).to(noop());
      const route2 = craft().id("route-2").from(simple("test2")).to(noop());
      export default [route1, route2];
    `,
    );
    const { runCommand } = runModule;
    const res = await runCommand("route-builder-array.js");
    expect(res).toEqual({ success: true });
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
     * @case --help parenthesises an array of alternatives, and only that
     * @preconditions Fields that are an array of a union, an array of such arrays, and an array of one const containing " | "
     * @expectedResult (string | number)[], (string | number)[][] and "a | b"[], so the brackets always bind to the whole item
     */
    test("renders array item types unambiguously in --help", async () => {
      const { renderArgvHelp } = await import("../src/format");
      const union = { anyOf: [{ type: "string" }, { type: "number" }] };
      const help = renderArgvHelp(
        {
          id: "r",
          input: {
            type: "object",
            properties: {
              flat: { type: "array", items: union },
              nested: {
                type: "array",
                items: { type: "array", items: union },
              },
              quoted: { type: "array", items: { const: "a | b" } },
            },
          },
        },
        "pretty",
      );
      expect(help).toMatch(/--flat\s+\(string \| number\)\[\]\s/);
      expect(help).toMatch(/--nested\s+\(string \| number\)\[\]\[\]\s/);
      expect(help).toMatch(/--quoted\s+"a \| b"\[\]\s/);
    });

    /**
     * @case --help starts nothing
     * @preconditions A file with an argv() route and a sibling route whose source writes a marker as soon as it starts
     * @expectedResult Exit 0 with the help text, and no marker, because help is answered before the context starts
     */
    test("answers --help without starting the file's routes", async () => {
      await writeFile(
        "with-sibling.ts",
        `
        import { writeFileSync } from "node:fs";
        import { craft, argv, simple } from "@routecraft/routecraft";
        export default [
          craft().id("cli").from(argv()).to(() => {}),
          craft().id("sibling").from(simple("x")).to(() => writeFileSync("started", "")),
        ];
      `,
      );
      const res = await runModule.runCommand(
        "with-sibling.ts",
        ["--help"],
        isolated(),
      );
      if (!("reply" in res)) throw new Error("expected a reply");
      expect(res.reply.code).toBe(0);
      expect(res.reply.output).toMatch(/Route: cli/);
      expect(existsSync("started")).toBe(false);
    });

    /**
     * @case A route field named like a craft run flag is refused before start
     * @preconditions An argv() route whose .input() body declares a "format" field
     * @expectedResult A usage failure (exit 2) naming the field
     */
    test("refuses an input field that collides with a craft run flag", async () => {
      await writeFile(
        "export.ts",
        ROUTE.replace(
          'properties: { id: { type: "string", description: "The work item id" } }',
          'properties: { id: { type: "string", description: "The work item id" }, format: { type: "string" } }',
        ),
      );
      const res = await runModule.runCommand(
        "export.ts",
        ["--id=1"],
        isolated(),
      );
      expect(res).toMatchObject({ success: false, code: 2 });
      if (!("message" in res)) throw new Error("expected a failure");
      expect(res.message).toMatch(/"format"/);
    });

    const TWO = `
      import { writeFileSync } from "node:fs";
      import { craft, argv } from "@routecraft/routecraft";
      export default [
        craft().id("a").title("First").from(argv()).to(() => writeFileSync("ran-a", "")),
        craft().id("b").from(argv()).transform((body) => {
          writeFileSync("ran-b", "");
          return { b: body.x };
        }),
      ];
    `;

    /**
     * @case A leading route name picks which argv() route runs
     * @preconditions A file with two argv() routes, the second named before the flags
     * @expectedResult Exit 0 with the second route's result, and the first never ran
     */
    test("runs the argv() route named first on the command line", async () => {
      await writeFile("two.ts", TWO);
      const res = await runModule.runCommand(
        "two.ts",
        ["b", "--x=1", "--format", "json"],
        isolated(),
      );
      if (!("reply" in res)) throw new Error("expected a reply");
      expect(res.reply.code).toBe(0);
      expect(JSON.parse(res.reply.output ?? "")).toEqual({
        outcome: "completed",
        body: { b: "1" },
      });
      expect(existsSync("ran-a")).toBe(false);
    });

    /**
     * @case Several argv() routes and no route name is a usage error before anything runs
     * @preconditions A file with two argv() routes, flags only
     * @expectedResult A usage failure (exit 2) naming both routes and how to pick one, and no route ran
     */
    test("asks for a route name when several routes read argv()", async () => {
      await writeFile("two.ts", TWO);
      const res = await runModule.runCommand("two.ts", ["--x=1"], isolated());
      expect(res).toMatchObject({ success: false, code: 2 });
      if (!("message" in res)) throw new Error("expected a failure");
      expect(res.message).toMatch(/"a", "b"/);
      expect(res.message).toMatch(/craft run <file> <route>/);
      expect(existsSync("ran-a")).toBe(false);
      expect(existsSync("ran-b")).toBe(false);
    });

    /**
     * @case A route name no argv() route carries is a usage error
     * @preconditions A file with two argv() routes and an unknown name
     * @expectedResult A usage failure (exit 2) naming the unknown route and listing the real ones
     */
    test("refuses a route name that no argv() route carries", async () => {
      await writeFile("two.ts", TWO);
      const res = await runModule.runCommand("two.ts", ["c"], isolated());
      expect(res).toMatchObject({ success: false, code: 2 });
      if (!("message" in res)) throw new Error("expected a failure");
      expect(res.message).toMatch(/"c" is not a route/);
      expect(res.message).toMatch(/"a", "b"/);
    });

    /**
     * @case --help with several argv() routes and no name lists them
     * @preconditions A file with two argv() routes, --help only
     * @expectedResult Exit 0 with both route ids, and nothing ran
     */
    test("lists the argv() routes for --help without a route name", async () => {
      await writeFile("two.ts", TWO);
      const res = await runModule.runCommand("two.ts", ["--help"], isolated());
      if (!("reply" in res)) throw new Error("expected a reply");
      expect(res.reply.code).toBe(0);
      expect(res.reply.output).toMatch(/a\s+First/);
      expect(res.reply.output).toMatch(/^\s+b\s*$/m);
      expect(existsSync("ran-a")).toBe(false);
      expect(existsSync("ran-b")).toBe(false);
    });

    /**
     * @case A route id that starts with a dash can still be named
     * @preconditions A file with two argv() routes, one whose id is "-b", named first
     * @expectedResult Exit 0 with that route's result, because a leading argument equal to a route id is the name
     */
    test("runs an argv() route whose id starts with a dash", async () => {
      await writeFile("dashed.ts", TWO.replace('id("b")', 'id("-b")'));
      const res = await runModule.runCommand(
        "dashed.ts",
        ["-b", "--x=1", "--format", "json"],
        isolated(),
      );
      if (!("reply" in res)) throw new Error("expected a reply");
      expect(res.reply.code).toBe(0);
      expect(JSON.parse(res.reply.output ?? "")).toMatchObject({
        body: { b: "1" },
      });
    });

    /**
     * @case The route listing follows --format
     * @preconditions A file with two argv() routes, --help with --format json and then raw
     * @expectedResult json is an array of the route descriptions, raw is one id per line
     */
    test("lists the argv() routes as json and raw", async () => {
      await writeFile("two.ts", TWO);
      const json = await runModule.runCommand(
        "two.ts",
        ["--help", "--format", "json"],
        isolated(),
      );
      if (!("reply" in json)) throw new Error("expected a reply");
      expect(JSON.parse(json.reply.output ?? "")).toMatchObject([
        { id: "a", title: "First" },
        { id: "b" },
      ]);
      const raw = await runModule.runCommand(
        "two.ts",
        ["--help", "--format", "raw"],
        isolated(),
      );
      if (!("reply" in raw)) throw new Error("expected a reply");
      expect(raw.reply.output).toBe("a\nb");
    });

    /**
     * @case A usage error names the route in its help hint
     * @preconditions A file with two argv() routes, the second named, then a stray positional
     * @expectedResult Exit 2, and the hint is the --help command for that route
     */
    test("points a usage error at the named route's --help", async () => {
      await writeFile("two.ts", TWO);
      const res = await runModule.runCommand(
        "two.ts",
        ["b", "stray"],
        isolated(),
      );
      if (!("reply" in res)) throw new Error("expected a reply");
      expect(res.reply.code).toBe(2);
      expect(res.reply.error).toMatch(/craft run <file> b --help/);
    });

    /**
     * @case --help after a route name describes that route
     * @preconditions A file with two argv() routes, the first named, then --help
     * @expectedResult Exit 0 with that route's help, and it never ran
     */
    test("answers --help for the named route", async () => {
      await writeFile("two.ts", TWO);
      const res = await runModule.runCommand(
        "two.ts",
        ["a", "--help"],
        isolated(),
      );
      if (!("reply" in res)) throw new Error("expected a reply");
      expect(res.reply.code).toBe(0);
      expect(res.reply.output).toMatch(/Route: a/);
      expect(existsSync("ran-a")).toBe(false);
      expect(existsSync("ran-b")).toBe(false);
    });

    /**
     * @case With one argv() route the name is optional but accepted
     * @preconditions A file with one argv() route, called with its id first
     * @expectedResult The same result as calling it without the name
     */
    test("accepts the route name when there is only one argv() route", async () => {
      await writeFile("work-item.ts", ROUTE);
      const res = await runModule.runCommand(
        "work-item.ts",
        ["work-item", "--id=9", "--format", "json"],
        isolated(),
      );
      if (!("reply" in res)) throw new Error("expected a reply");
      expect(res.reply.code).toBe(0);
      expect(JSON.parse(res.reply.output ?? "")).toMatchObject({
        body: { found: "9" },
      });
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
