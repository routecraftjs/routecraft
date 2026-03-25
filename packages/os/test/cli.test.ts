import { describe, test, expect, afterEach, vi } from "vitest";
import { z } from "zod";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, noop, RUNNER_ARGV } from "@routecraft/routecraft";
import {
  cli,
  ADAPTER_CLI_REGISTRY,
  isCliSource,
  parseFlags,
  extractJsonSchema,
} from "@routecraft/os";

/**
 * CLI adapter tests
 *
 * Covers flag parsing, schema validation, command dispatch, help registration,
 * stdout/stderr destinations, aliases, positional args, env fallback, examples,
 * and the isCliSource detection utility.
 */

// ============================================================
// Group 1: parseFlags utility (schema-less fallback)
// ============================================================
describe("parseFlags", () => {
  /**
   * @case String flag with value
   * @preconditions JSON Schema defines property as string type
   * @expectedResult Flag value captured as string
   */
  test("parses string flag", () => {
    const result = parseFlags(["--name", "Alice"], {
      properties: { name: { type: "string" } },
    });
    expect(result).toEqual({ name: "Alice" });
  });

  /**
   * @case Number flag with value
   * @preconditions JSON Schema defines property as number type
   * @expectedResult Flag value coerced to number
   */
  test("coerces number flag", () => {
    const result = parseFlags(["--count", "42"], {
      properties: { count: { type: "number" } },
    });
    expect(result).toEqual({ count: 42 });
  });

  /**
   * @case Boolean flag without value
   * @preconditions JSON Schema defines property as boolean type
   * @expectedResult Flag presence means true
   */
  test("boolean flag presence is true", () => {
    const result = parseFlags(["--verbose"], {
      properties: { verbose: { type: "boolean" } },
    });
    expect(result).toEqual({ verbose: true });
  });

  /**
   * @case Negated boolean flag
   * @preconditions Token starts with --no-
   * @expectedResult Flag value is false
   */
  test("--no-flag sets value to false", () => {
    const result = parseFlags(["--no-verbose"]);
    expect(result).toEqual({ verbose: false });
  });

  /**
   * @case kebab-case flag converted to camelCase key
   * @preconditions Flag uses kebab-case
   * @expectedResult Result key is camelCase
   */
  test("kebab-case flag is camelCased", () => {
    const result = parseFlags(["--dry-run", "false"], {
      properties: { dryRun: { type: "string" } },
    });
    expect(result).toEqual({ dryRun: "false" });
  });

  /**
   * @case Multiple flags parsed together
   * @preconditions Mixed string, number, and boolean flags in a single args array
   * @expectedResult All flags captured with correct types
   */
  test("parses multiple flags", () => {
    const result = parseFlags(["--name", "Bob", "--count", "3", "--verbose"], {
      properties: {
        name: { type: "string" },
        count: { type: "integer" },
        verbose: { type: "boolean" },
      },
    });
    expect(result).toEqual({ name: "Bob", count: 3, verbose: true });
  });

  /**
   * @case Unknown flag without schema hint
   * @preconditions No JSON Schema provided
   * @expectedResult Flag captured as string value
   */
  test("unknown flag without schema treated as string", () => {
    const result = parseFlags(["--env", "staging"]);
    expect(result).toEqual({ env: "staging" });
  });

  /**
   * @case Flag followed immediately by another flag (no value)
   * @preconditions No value token between two flags
   * @expectedResult Flag without value is treated as boolean true
   */
  test("flag with no value before next flag defaults to true", () => {
    const result = parseFlags(["--dry-run", "--name", "Alice"]);
    expect(result).toEqual({ dryRun: true, name: "Alice" });
  });
});

// ============================================================
// Group 2: extractJsonSchema utility
// ============================================================
describe("extractJsonSchema", () => {
  /**
   * @case Zod schema with jsonSchema accessor
   * @preconditions Zod schema with object shape
   * @expectedResult Returns JSON Schema with properties
   */
  test("extracts JSON Schema from zod schema", () => {
    const schema = z.object({ name: z.string() });
    const result = extractJsonSchema(schema);
    expect(result).toHaveProperty("properties");
    expect(
      (result["properties"] as Record<string, unknown>)["name"],
    ).toBeDefined();
  });

  /**
   * @case Schema without jsonSchema accessor
   * @preconditions Schema uses only ~standard.validate (no jsonSchema)
   * @expectedResult Falls back to { type: "object" }
   */
  test("falls back to { type: object } when no jsonSchema accessor", () => {
    const minimalSchema = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (v: unknown) => ({ value: v }),
      },
    };
    const result = extractJsonSchema(minimalSchema);
    expect(result).toEqual({ type: "object" });
  });
});

// ============================================================
// Group 3: isCliSource detection
// ============================================================
describe("isCliSource", () => {
  /**
   * @case cli() source adapter is detected
   * @preconditions Source created with cli()
   * @expectedResult Returns true
   */
  test("returns true for cli() source", () => {
    const source = cli("test");
    expect(isCliSource(source)).toBe(true);
  });

  /**
   * @case Non-CLI source is not detected
   * @preconditions Plain function used as source
   * @expectedResult Returns false
   */
  test("returns false for non-cli source", () => {
    expect(isCliSource({ adapterId: "routecraft.adapter.direct" })).toBe(false);
    expect(isCliSource(null)).toBe(false);
    expect(isCliSource({})).toBe(false);
  });
});

// ============================================================
// Group 4: CLI source adapter -- dispatch behaviour
// ============================================================
describe("CLI source adapter dispatch", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case Matched command fires handler with parsed flags (schema-less)
   * @preconditions RUNNER_ARGV store set with matching command and flags, no schema
   * @expectedResult Handler called once with parsed flag values
   */
  test("matched command dispatches with parsed flags (schema-less)", async () => {
    const consumer = vi.fn();

    t = await testContext()
      .store(RUNNER_ARGV, ["greet", "--name", "Alice"])
      .routes([craft().id("greet").from(cli("greet")).to(consumer)])
      .build();

    await t.test();
    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer.mock.calls[0]![0].body).toEqual({ name: "Alice" });
  });

  /**
   * @case Matched command fires handler with parsed flags (with schema)
   * @preconditions RUNNER_ARGV store set with matching command, schema defined
   * @expectedResult Handler called once with validated flag values
   */
  test("matched command dispatches with parsed flags (with schema)", async () => {
    const consumer = vi.fn();
    const schema = z.object({ name: z.string() });

    t = await testContext()
      .store(RUNNER_ARGV, ["greet", "--name", "Alice"])
      .routes([craft().id("greet").from(cli("greet", { schema })).to(consumer)])
      .build();

    await t.test();
    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer.mock.calls[0]![0].body).toEqual({ name: "Alice" });
  });

  /**
   * @case Unmatched command does not fire handler
   * @preconditions RUNNER_ARGV has a different command name
   * @expectedResult Handler is never called
   */
  test("unmatched command does not fire handler", async () => {
    const consumer = vi.fn();
    // Suppress commander error output
    vi.spyOn(console, "error").mockImplementation(() => {});

    t = await testContext()
      .store(RUNNER_ARGV, ["other"])
      .routes([craft().id("greet").from(cli("greet")).to(consumer)])
      .build();

    await t.test();
    expect(consumer).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  /**
   * @case No RUNNER_ARGV in store does not fire handler
   * @preconditions RUNNER_ARGV not set in context (programmatic use)
   * @expectedResult Handler is never called
   */
  test("no RUNNER_ARGV in store skips handler", async () => {
    const consumer = vi.fn();

    t = await testContext()
      .routes([craft().id("greet").from(cli("greet")).to(consumer)])
      .build();

    await t.test();
    expect(consumer).not.toHaveBeenCalled();
  });

  /**
   * @case Multiple commands register but only the matched one fires
   * @preconditions Two CLI routes; one command invoked
   * @expectedResult Only the matching route handler is called
   */
  test("only matched command fires among multiple commands", async () => {
    const greetConsumer = vi.fn();
    const deployConsumer = vi.fn();

    t = await testContext()
      .store(RUNNER_ARGV, ["greet", "--name", "World"])
      .routes([
        craft().id("greet").from(cli("greet")).to(greetConsumer),
        craft().id("deploy").from(cli("deploy")).to(deployConsumer),
      ])
      .build();

    await t.test();
    expect(greetConsumer).toHaveBeenCalledTimes(1);
    expect(deployConsumer).not.toHaveBeenCalled();
  });

  /**
   * @case CLI registry is populated during subscribe
   * @preconditions Two CLI routes built and started with RUNNER_ARGV
   * @expectedResult Both commands appear in ADAPTER_CLI_REGISTRY store
   */
  test("commands are registered in CLI registry", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    t = await testContext()
      .store(RUNNER_ARGV, [])
      .routes([
        craft()
          .id("greet")
          .from(cli("greet", { description: "Say hello" }))
          .to(noop()),
        craft()
          .id("deploy")
          .from(cli("deploy", { description: "Deploy the app" }))
          .to(noop()),
      ])
      .build();

    await t.test();

    const registry = t.ctx.getStore(ADAPTER_CLI_REGISTRY);
    expect(registry).toBeDefined();
    expect(registry!.has("greet")).toBe(true);
    expect(registry!.get("greet")!.description).toBe("Say hello");
    expect(registry!.has("deploy")).toBe(true);
    vi.restoreAllMocks();
  });

  /**
   * @case Help is printed when no command given
   * @preconditions RUNNER_ARGV is empty array
   * @expectedResult Help text printed to stderr containing command names
   */
  test("prints help when no command given", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    t = await testContext()
      .store(RUNNER_ARGV, [])
      .routes([
        craft()
          .id("greet")
          .from(cli("greet", { description: "Say hello" }))
          .to(noop()),
        craft()
          .id("deploy")
          .from(cli("deploy", { description: "Deploy the app" }))
          .to(noop()),
      ])
      .build();

    await t.test();

    expect(errorSpy).toHaveBeenCalled();
    const helpText = errorSpy.mock.calls[0]![0] as string;
    expect(helpText).toContain("greet");
    expect(helpText).toContain("deploy");
    expect(helpText).toContain("Say hello");
    errorSpy.mockRestore();
  });

  /**
   * @case Unknown command prints error
   * @preconditions RUNNER_ARGV contains a command not in any route
   * @expectedResult console.error called with unknown command message
   */
  test("prints error for unknown command", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    t = await testContext()
      .store(RUNNER_ARGV, ["nonexistent"])
      .routes([craft().id("greet").from(cli("greet")).to(noop())])
      .build();

    await t.test();

    expect(errorSpy).toHaveBeenCalled();
    const errorText = errorSpy.mock.calls[0]![0] as string;
    expect(errorText).toContain("nonexistent");
    errorSpy.mockRestore();
  });
});

// ============================================================
// Group 5: CLI source adapter -- schema validation
// ============================================================
describe("CLI source adapter schema validation", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case Valid flags pass schema validation
   * @preconditions Flags match schema requirements
   * @expectedResult Handler receives validated and coerced body
   */
  test("valid flags pass schema and reach handler", async () => {
    const consumer = vi.fn();
    const schema = z.object({ name: z.string(), count: z.number() });

    t = await testContext()
      .store(RUNNER_ARGV, ["run", "--name", "test", "--count", "5"])
      .routes([craft().id("run").from(cli("run", { schema })).to(consumer)])
      .build();

    await t.test();
    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer.mock.calls[0]![0].body).toEqual({
      name: "test",
      count: 5,
    });
  });

  /**
   * @case Missing required flag throws RC5002
   * @preconditions Schema requires a field that is absent from argv
   * @expectedResult RC5002 error emitted; handler not called
   */
  test("missing required flag emits RC5002", async () => {
    const consumer = vi.fn();
    const schema = z.object({ name: z.string() });

    t = await testContext()
      .store(RUNNER_ARGV, ["greet"])
      .routes([craft().id("greet").from(cli("greet", { schema })).to(consumer)])
      .build();

    await t.test();
    expect(t.errors).toHaveLength(1);
    expect(t.errors[0]!.rc).toBe("RC5002");
    expect(consumer).not.toHaveBeenCalled();
  });

  /**
   * @case Schema coercion applied to validated body
   * @preconditions Zod schema transforms input (e.g. default value)
   * @expectedResult Handler receives coerced value from schema
   */
  test("schema coercion applied to body", async () => {
    const consumer = vi.fn();
    const schema = z.object({
      name: z.string(),
      loud: z.boolean().default(false),
    });

    t = await testContext()
      .store(RUNNER_ARGV, ["greet", "--name", "Bob"])
      .routes([craft().id("greet").from(cli("greet", { schema })).to(consumer)])
      .build();

    await t.test();
    expect(consumer.mock.calls[0]![0].body).toEqual({
      name: "Bob",
      loud: false,
    });
  });
});

// ============================================================
// Group 6: CLI destination adapter
// ============================================================
describe("CLI destination adapter", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case cli.stdout() writes string body to stdout
   * @preconditions String body routed to cli.stdout()
   * @expectedResult process.stdout.write called with the string
   */
  test("cli.stdout() writes string to stdout", async () => {
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    t = await testContext()
      .store(RUNNER_ARGV, ["hello"])
      .routes([
        craft()
          .id("hello")
          .from(cli("hello"))
          .transform(() => "Hello, World!")
          .to(cli.stdout()),
      ])
      .build();

    await t.test();
    expect(writeSpy).toHaveBeenCalledWith("Hello, World!\n");
    writeSpy.mockRestore();
  });

  /**
   * @case cli.stdout() JSON-stringifies object body
   * @preconditions Object body routed to cli.stdout()
   * @expectedResult process.stdout.write called with JSON string
   */
  test("cli.stdout() JSON-stringifies object body", async () => {
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    t = await testContext()
      .store(RUNNER_ARGV, ["info"])
      .routes([
        craft()
          .id("info")
          .from(cli("info"))
          .transform(() => ({ version: "1.0.0" }))
          .to(cli.stdout()),
      ])
      .build();

    await t.test();
    expect(writeSpy).toHaveBeenCalledWith(
      JSON.stringify({ version: "1.0.0" }, null, 2) + "\n",
    );
    writeSpy.mockRestore();
  });

  /**
   * @case cli.stderr() writes to stderr instead of stdout
   * @preconditions String body routed to cli.stderr()
   * @expectedResult process.stderr.write called; stdout not written
   */
  test("cli.stderr() writes to stderr", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    t = await testContext()
      .store(RUNNER_ARGV, ["err"])
      .routes([
        craft()
          .id("err")
          .from(cli("err"))
          .transform(() => "error message")
          .to(cli.stderr()),
      ])
      .build();

    await t.test();
    expect(stderrSpy).toHaveBeenCalledWith("error message\n");
    expect(stdoutSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });
});

// ============================================================
// Group 7: Schema mode -- auto-generated aliases
// ============================================================
describe("Schema mode -- auto-generated aliases", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case Auto-alias uses first letter of property name
   * @preconditions Schema defines "name" property
   * @expectedResult -n Alice dispatches body { name: "Alice" }
   */
  test("auto-alias from first letter works", async () => {
    const consumer = vi.fn();
    const schema = z.object({ name: z.string() });

    t = await testContext()
      .store(RUNNER_ARGV, ["greet", "-n", "Alice"])
      .routes([craft().id("greet").from(cli("greet", { schema })).to(consumer)])
      .build();

    await t.test();
    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer.mock.calls[0]![0].body).toEqual({ name: "Alice" });
  });

  /**
   * @case Auto-alias for boolean flag
   * @preconditions Schema defines "loud" as boolean
   * @expectedResult -l sets loud to true
   */
  test("auto-alias for boolean flag sets true", async () => {
    const consumer = vi.fn();
    const schema = z.object({
      name: z.string(),
      loud: z.boolean().default(false),
    });

    t = await testContext()
      .store(RUNNER_ARGV, ["greet", "--name", "Bob", "-l"])
      .routes([craft().id("greet").from(cli("greet", { schema })).to(consumer)])
      .build();

    await t.test();
    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer.mock.calls[0]![0].body).toEqual({
      name: "Bob",
      loud: true,
    });
  });

  /**
   * @case Auto-alias shows in help text
   * @preconditions Schema has "name" property, --help requested
   * @expectedResult Help output contains -n and --name
   */
  test("auto-alias shows in help text", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const schema = z.object({ name: z.string() });

    t = await testContext()
      .store(RUNNER_ARGV, ["greet", "--help"])
      .routes([
        craft()
          .id("greet")
          .from(cli("greet", { schema, description: "Say hello" }))
          .to(noop()),
      ])
      .build();

    await t.test();
    expect(logSpy).toHaveBeenCalled();
    const helpText = logSpy.mock.calls[0]![0] as string;
    expect(helpText).toContain("-n");
    expect(helpText).toContain("--name");
    logSpy.mockRestore();
  });
});

// ============================================================
// Group 8: Native mode -- positional arguments and flags
// ============================================================
describe("Native mode -- positional arguments and flags", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case Positional argument is captured by name
   * @preconditions Native mode with args defining "target"
   * @expectedResult Body contains { target: "prod" }
   */
  test("positional argument maps to body by name", async () => {
    const consumer = vi.fn();

    t = await testContext()
      .store(RUNNER_ARGV, ["deploy", "prod"])
      .routes([
        craft()
          .id("deploy")
          .from(
            cli("deploy", {
              args: [{ name: "target", description: "Deploy target" }],
            }),
          )
          .to(consumer),
      ])
      .build();

    await t.test();
    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer.mock.calls[0]![0].body).toEqual({ target: "prod" });
  });

  /**
   * @case Positional + flags combined in native mode
   * @preconditions args for "target", flags for "dryRun"
   * @expectedResult Body contains both positional and flag values
   */
  test("positional and flags combined in body", async () => {
    const consumer = vi.fn();

    t = await testContext()
      .store(RUNNER_ARGV, ["deploy", "staging", "--dry-run"])
      .routes([
        craft()
          .id("deploy")
          .from(
            cli("deploy", {
              args: [{ name: "target" }],
              flags: {
                dryRun: { alias: "d", type: "boolean" },
              },
            }),
          )
          .to(consumer),
      ])
      .build();

    await t.test();
    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer.mock.calls[0]![0].body).toEqual({
      target: "staging",
      dryRun: true,
    });
  });

  /**
   * @case JSON object as positional argument
   * @preconditions Native mode positional arg contains a JSON string
   * @expectedResult Body contains the parsed JSON object
   */
  test("JSON positional argument is parsed", async () => {
    const consumer = vi.fn();

    t = await testContext()
      .store(RUNNER_ARGV, ["apply", '{"db":"postgres","cache":"redis"}'])
      .routes([
        craft()
          .id("apply")
          .from(cli("apply", { args: [{ name: "config" }] }))
          .to(consumer),
      ])
      .build();

    await t.test();
    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer.mock.calls[0]![0].body).toEqual({
      config: { db: "postgres", cache: "redis" },
    });
  });

  /**
   * @case Native mode alias dispatches correctly
   * @preconditions Flags define alias "n" for name
   * @expectedResult -n Alice dispatches body { name: "Alice" }
   */
  test("native mode alias dispatches correctly", async () => {
    const consumer = vi.fn();

    t = await testContext()
      .store(RUNNER_ARGV, ["greet", "-n", "Alice"])
      .routes([
        craft()
          .id("greet")
          .from(
            cli("greet", {
              flags: { name: { alias: "n", type: "string" } },
            }),
          )
          .to(consumer),
      ])
      .build();

    await t.test();
    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer.mock.calls[0]![0].body).toEqual({ name: "Alice" });
  });

  /**
   * @case Native mode number coercion
   * @preconditions Flag type is "number"
   * @expectedResult Body value is a number, not a string
   */
  test("native mode number flag is coerced", async () => {
    const consumer = vi.fn();

    t = await testContext()
      .store(RUNNER_ARGV, ["run", "--count", "42"])
      .routes([
        craft()
          .id("run")
          .from(cli("run", { flags: { count: { type: "number" } } }))
          .to(consumer),
      ])
      .build();

    await t.test();
    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer.mock.calls[0]![0].body).toEqual({ count: 42 });
  });
});

// ============================================================
// Group 9: Native mode -- env fallback
// ============================================================
describe("Native mode -- env fallback", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case Env var used when flag is not provided
   * @preconditions Flag not in argv, env var set
   * @expectedResult Body contains value from env var
   */
  test("env var used as fallback when flag absent", async () => {
    const consumer = vi.fn();

    const original = process.env["TEST_GREET_NAME"];
    process.env["TEST_GREET_NAME"] = "FromEnv";

    try {
      t = await testContext()
        .store(RUNNER_ARGV, ["greet"])
        .routes([
          craft()
            .id("greet")
            .from(
              cli("greet", {
                flags: {
                  name: { type: "string", env: "TEST_GREET_NAME" },
                },
              }),
            )
            .to(consumer),
        ])
        .build();

      await t.test();
      expect(consumer).toHaveBeenCalledTimes(1);
      expect(consumer.mock.calls[0]![0].body).toEqual({ name: "FromEnv" });
    } finally {
      if (original === undefined) {
        delete process.env["TEST_GREET_NAME"];
      } else {
        process.env["TEST_GREET_NAME"] = original;
      }
    }
  });

  /**
   * @case Explicit flag takes precedence over env var
   * @preconditions Both flag and env var set
   * @expectedResult Body contains value from flag, not env
   */
  test("explicit flag overrides env var", async () => {
    const consumer = vi.fn();

    const original = process.env["TEST_GREET_NAME2"];
    process.env["TEST_GREET_NAME2"] = "FromEnv";

    try {
      t = await testContext()
        .store(RUNNER_ARGV, ["greet", "--name", "FromFlag"])
        .routes([
          craft()
            .id("greet")
            .from(
              cli("greet", {
                flags: {
                  name: { type: "string", env: "TEST_GREET_NAME2" },
                },
              }),
            )
            .to(consumer),
        ])
        .build();

      await t.test();
      expect(consumer).toHaveBeenCalledTimes(1);
      expect(consumer.mock.calls[0]![0].body).toEqual({ name: "FromFlag" });
    } finally {
      if (original === undefined) {
        delete process.env["TEST_GREET_NAME2"];
      } else {
        process.env["TEST_GREET_NAME2"] = original;
      }
    }
  });
});

// ============================================================
// Group 10: Examples in help
// ============================================================
describe("Examples in help", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case Examples appear in per-command help (native mode)
   * @preconditions examples option provided, --help requested
   * @expectedResult Help output contains the example strings
   */
  test("examples shown in per-command help", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    t = await testContext()
      .store(RUNNER_ARGV, ["greet", "--help"])
      .routes([
        craft()
          .id("greet")
          .from(
            cli("greet", {
              description: "Say hello",
              flags: { name: { type: "string" } },
              examples: ["greet --name Alice", "greet --name Bob"],
            }),
          )
          .to(noop()),
      ])
      .build();

    await t.test();
    expect(logSpy).toHaveBeenCalled();
    const helpText = logSpy.mock.calls[0]![0] as string;
    expect(helpText).toContain("Examples:");
    expect(helpText).toContain("greet --name Alice");
    expect(helpText).toContain("greet --name Bob");
    logSpy.mockRestore();
  });
});
