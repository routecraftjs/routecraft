import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import { agentPlugin, tools } from "../src/index.ts";
import type { FnHandlerContext, ToolGuard } from "../src/fn/types.ts";
import type { ToolsItem } from "../src/agent/tools/selection.ts";

/**
 * Specifier-seam behaviour: the grammar half of `Tool(specifier)`.
 *
 * What is asserted here is the dispatch, not any particular matcher. The
 * tool under test compiles its specifiers into a guard that simply records
 * what it was given, so a failure points at the seam rather than at
 * whichever matcher a real tool would supply.
 */

/** Specifiers the tool's compile step last received. */
let compiledWith: readonly string[] = [];

const echoSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "test",
    validate: (value: unknown) => ({ value }),
  },
};

/** A tool that accepts a specifier and refuses anything not named by one. */
const narrowable = {
  description: "Runs a command",
  input: echoSchema,
  handler: async (): Promise<string> => "ok",
  specifier: {
    kind: "command-pattern" as const,
    compile: (specifiers: readonly string[]): ToolGuard => {
      compiledWith = specifiers;
      return (input: unknown) => {
        const command = (input as { command?: string })?.command ?? "";
        if (
          !specifiers.some((s) => command.startsWith(s.replace(/:\*$/, "")))
        ) {
          throw new Error(`not permitted: ${command}`);
        }
      };
    },
  },
};

/** A tool that does not accept a specifier. */
const plain = {
  description: "Plain",
  input: echoSchema,
  handler: async (): Promise<string> => "ok",
};

const handlerCtx = {} as FnHandlerContext;

describe("use-site specifiers", () => {
  let t: TestContext | undefined;
  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
    compiledWith = [];
  });

  async function resolve(items: ToolsItem[]) {
    t = await testContext()
      .with({
        plugins: [agentPlugin({ functions: { Bash: narrowable, plain } })],
      })
      .build();
    return tools(items).resolve(t.ctx);
  }

  /**
   * @case A specifier resolves the tool under its bare name
   * @preconditions A single scoped reference
   * @expectedResult One tool named Bash, carrying a guard
   */
  test("a scoped reference resolves to the bare tool name", async () => {
    const resolved = await resolve(["Bash(git status:*)"]);
    expect(resolved.map((r) => r.name)).toEqual(["Bash"]);
    expect(typeof resolved[0]!.guard).toBe("function");
  });

  /**
   * @case The specifier reaches the tool that declared how to read it
   * @preconditions A scoped reference with a command surface
   * @expectedResult The tool's compile step receives the specifier text verbatim
   */
  test("the specifier is handed to the tool that declared it", async () => {
    await resolve(["Bash(git status:*)"]);
    expect(compiledWith).toEqual(["git status:*"]);
  });

  /**
   * @case Repeated entries for one tool union rather than replace
   * @preconditions Two scoped references naming the same tool
   * @expectedResult Both specifiers are compiled together into one tool
   */
  test("repeated entries union their specifiers", async () => {
    const resolved = await resolve(["Bash(git status:*)", "Bash(ls:*)"]);
    expect(resolved.map((r) => r.name)).toEqual(["Bash"]);
    expect([...compiledWith].sort()).toEqual(["git status:*", "ls:*"]);
  });

  /**
   * @case The compiled guard admits what the specifiers name
   * @preconditions A tool granted a command surface, called with a matching command
   * @expectedResult The guard returns without throwing
   */
  test("the guard admits a command the specifier names", async () => {
    const resolved = await resolve(["Bash(git status:*)"]);
    await expect(
      (async () =>
        resolved[0]!.guard!({ command: "git status --short" }, handlerCtx))(),
    ).resolves.toBeUndefined();
  });

  /**
   * @case The compiled guard refuses what no specifier names
   * @preconditions The same tool called with an unnamed command
   * @expectedResult The guard throws, so the grant is enforced at call time
   */
  test("the guard refuses a command no specifier names", async () => {
    const resolved = await resolve(["Bash(git status:*)"]);
    // Invoked inside a thunk: a synchronous guard throws before any
    // promise exists to reject.
    await expect(
      (async () => resolved[0]!.guard!({ command: "rm -rf /" }, handlerCtx))(),
    ).rejects.toThrow(/not permitted/);
  });

  /**
   * @case A specifier on a tool that does not accept one is fatal
   * @preconditions A scoped reference naming a tool with no specifier declaration
   * @expectedResult Throws, because ignoring the specifier would widen the grant
   */
  test("a specifier on a tool that accepts none throws", async () => {
    await expect(resolve(["plain(anything)"])).rejects.toThrow(
      /does not accept one/,
    );
  });

  /**
   * @case An empty specifier is a typo rather than a grant of everything
   * @preconditions A reference with nothing inside the parentheses
   * @expectedResult Throws rather than resolving to an unconstrained tool
   */
  test("an empty specifier throws", async () => {
    await expect(resolve(["Bash()"])).rejects.toThrow(/empty specifier/);
  });

  /**
   * @case Both an explicit guard and a specifier guard must pass
   * @preconditions An object entry carrying its own guard alongside a specifier
   * @expectedResult A command the specifier permits is still refused by the explicit guard
   */
  test("an explicit guard composes with the specifier's", async () => {
    const resolved = await resolve([
      {
        name: "Bash(git status:*)",
        guard: () => {
          throw new Error("explicit guard refused");
        },
      },
    ]);
    await expect(
      (async () =>
        resolved[0]!.guard!({ command: "git status" }, handlerCtx))(),
    ).rejects.toThrow(/explicit guard refused/);
  });

  /**
   * @case A guard on one entry survives a second entry for the same tool
   * @preconditions An object entry carrying a guard, followed by a bare scoped entry for the same tool
   * @expectedResult The guard still runs, rather than being overwritten by whichever entry came last
   */
  test("a later entry does not drop an earlier entry's guard", async () => {
    const resolved = await resolve([
      {
        name: "Bash(git status:*)",
        guard: () => {
          throw new Error("explicit guard refused");
        },
      },
      "Bash(ls:*)",
    ]);
    expect(resolved).toHaveLength(1);
    await expect(
      (async () =>
        resolved[0]!.guard!({ command: "git status" }, handlerCtx))(),
    ).rejects.toThrow(/explicit guard refused/);
  });

  /**
   * @case Reserved constructors keep their own meaning
   * @preconditions References using the Direct and MCP grammar
   * @expectedResult They are not read as specifiers, so they fail as unknown identities instead
   */
  test("reserved constructors are not read as specifiers", async () => {
    await expect(resolve(["Direct(no-such-route)"])).rejects.toThrow(
      /no-such-route|unknown|not registered|capabilit/i,
    );
  });
});
