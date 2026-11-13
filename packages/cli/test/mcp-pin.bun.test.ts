import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { mcpPinCommand } = await import("../src/mcp-pin");

const PIN_COMMAND = Symbol.for("routecraft.mcp.pin");
const g = globalThis as Record<symbol, unknown>;

describe("craft mcp pin", () => {
  let root: string;
  let cwd: string;
  let saved: unknown;
  let counter = 0;

  beforeEach(() => {
    counter += 1;
    root = join(import.meta.dir, `tmp-mcp-pin-${Date.now()}-${counter}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "craft.config.ts"),
      "export const craftConfig = {};\n",
    );
    cwd = process.cwd();
    process.chdir(root);
    saved = g[PIN_COMMAND];
    delete g[PIN_COMMAND];
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
    if (saved === undefined) delete g[PIN_COMMAND];
    else g[PIN_COMMAND] = saved;
  });

  /**
   * @case The command reports what changed per client, with remote names made safe to print
   * @preconditions A registered pin command returning one client with an added tool whose name carries an escape sequence, a changed and a removed tool, and one client that failed
   * @expectedResult Exit 1 for the failure; the output counts and lists the tools, the escape sequence is printed as a \u escape, the file is named for review and commit, and the failed client is named with its reason
   */
  test("prints the comparison and escapes remote names", async () => {
    const asked: unknown[] = [];
    g[PIN_COMMAND] = async (_config: unknown, request: { client?: string }) => {
      asked.push(request.client);
      return {
        path: join(root, "mcp.lock"),
        written: true,
        clients: [
          {
            id: "books",
            added: [{ name: "pay\u001b[2Kment", class: "destructive" }],
            changed: ["get_invoice"],
            removed: ["old_tool"],
            unchanged: 3,
          },
        ],
        failed: [{ id: "crm", reason: "connection refused" }],
      };
    };

    const result = await mcpPinCommand("books");

    expect(asked).toEqual(["books"]);
    expect(result.code).toBe(1);
    expect(result.output).toBe(
      [
        "books: 5 tools, 1 added, 1 changed, 1 removed",
        "  + pay\\u001b[2Kment  (class: destructive)",
        "  ~ get_invoice",
        "  - old_tool",
        "Wrote mcp.lock. Check the class of each added tool, review the diff, and commit it to approve.",
      ].join("\n"),
    );
    expect(result.error).toBe(
      '"crm" was not listed, and its locked tools are unchanged: connection refused',
    );
  });

  /**
   * @case Nothing registered the pin command
   * @preconditions A project whose config does not import @routecraft/ai
   * @expectedResult Exit 1 with the import to add
   */
  test("says what to import when @routecraft/ai is not loaded", async () => {
    const result = await mcpPinCommand(undefined);
    expect(result.code).toBe(1);
    expect(result.error).toContain('import "@routecraft/ai";');
  });

  /**
   * @case An unchanged lockfile and a refusal from the command
   * @preconditions A pin command reporting nothing written, then one that throws
   * @expectedResult Exit 0 saying the file is up to date; then exit 1 with the thrown message
   */
  test("reports an up-to-date lockfile and a refusal", async () => {
    g[PIN_COMMAND] = async () => ({
      path: join(root, "mcp.lock"),
      written: false,
      clients: [
        { id: "books", added: [], changed: [], removed: [], unchanged: 2 },
      ],
      failed: [],
    });
    expect(await mcpPinCommand(undefined)).toEqual({
      code: 0,
      output:
        "books: 2 tools, 0 added, 0 changed, 0 removed\nmcp.lock is up to date.",
    });

    g[PIN_COMMAND] = async () => {
      throw new Error("No MCP client sets pins, so there is nothing to pin.");
    };
    expect(await mcpPinCommand(undefined)).toEqual({
      code: 1,
      error: "No MCP client sets pins, so there is nothing to pin.",
    });
  });
});
