import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agents, isToolSelection, tools } from "../src/index.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rc-agents-"));
}

describe("agents() markdown loader", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  function makeDir(files: Record<string, string>): string {
    const dir = tmpDir();
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content, "utf-8");
    }
    return dir;
  }

  /**
   * @case Loads a directory of agent markdown files into a Record keyed by name
   * @preconditions Two agents with description, model, and body
   * @expectedResult Both agents loaded; body becomes system; provider:model passed through
   */
  test("loads agents with name/description/model/system", async () => {
    const dir = makeDir({
      "researcher.md":
        "---\nname: researcher\ndescription: Researches things\nmodel: anthropic:claude-sonnet-4-6\n---\nYou are a researcher.",
      "writer.md":
        "---\nname: writer\ndescription: Writes prose\nmodel: openai:gpt-5\n---\nYou are a writer.",
    });
    const result = await agents(dir);
    expect(Object.keys(result).sort()).toEqual(["researcher", "writer"]);
    expect(result["researcher"]).toMatchObject({
      description: "Researches things",
      model: "anthropic:claude-sonnet-4-6",
      system: "You are a researcher.",
    });
  });

  /**
   * @case maxTurns and skills frontmatter pass through
   * @preconditions Agent with maxTurns: 30 and skills: [a, b]
   * @expectedResult AgentRegisteredOptions has both fields
   */
  test("maxTurns and skills frontmatter pass through", async () => {
    const dir = makeDir({
      "x.md":
        "---\nname: x\ndescription: d\nmaxTurns: 30\nskills:\n  - one\n  - two\n---\nsystem prompt",
    });
    const result = await agents(dir);
    expect(result["x"]?.maxTurns).toBe(30);
    expect(result["x"]?.skills).toEqual(["one", "two"]);
  });

  /**
   * @case tools string array becomes a tools([...]) selection
   * @preconditions Agent with tools: [fetchOrder, "tagged:read-only"]
   * @expectedResult agent.tools is a ToolSelection (brand check via isToolSelection)
   */
  test("tools frontmatter becomes a tools([...]) selection", async () => {
    const dir = makeDir({
      "x.md":
        '---\nname: x\ndescription: d\ntools:\n  - fetchOrder\n  - "tagged:read-only"\n---\nsystem',
    });
    const result = await agents(dir);
    expect(isToolSelection(result["x"]?.tools)).toBe(true);
  });

  /**
   * @case Unsupported Claude frontmatter field throws not-yet-supported
   * @preconditions Agent with permissionMode set
   * @expectedResult Throws RC5003 mentioning the field and the supported list
   */
  test("rejects unsupported Claude subagent frontmatter fields", async () => {
    const dir = makeDir({
      "x.md":
        "---\nname: x\ndescription: d\npermissionMode: default\n---\nsystem",
    });
    await expect(agents(dir)).rejects.toThrow(
      /frontmatter field "permissionMode" is not yet supported/,
    );
  });

  /**
   * @case Bare model alias rejected with a clear hint
   * @preconditions model: sonnet (no provider:)
   * @expectedResult Throws RC5003 telling the user to use full provider:model form
   */
  test("rejects bare model aliases like 'sonnet'", async () => {
    const dir = makeDir({
      "x.md": "---\nname: x\ndescription: d\nmodel: sonnet\n---\nsystem",
    });
    await expect(agents(dir)).rejects.toThrow(/full "provider:model" form/);
  });

  /**
   * @case Per-agent override replaces fields from frontmatter
   * @preconditions Override sets maxTurns and replaces tools
   * @expectedResult Loaded agent reflects overrides; non-overridden fields preserved
   */
  test("applies per-agent overrides", async () => {
    const dir = makeDir({
      "x.md": "---\nname: x\ndescription: from-md\nmaxTurns: 5\n---\nsystem",
    });
    const result = await agents(dir, {
      x: { maxTurns: 30, tools: tools(["foo"]) },
    });
    expect(result["x"]?.maxTurns).toBe(30);
    expect(isToolSelection(result["x"]?.tools)).toBe(true);
    expect(result["x"]?.description).toBe("from-md");
  });

  /**
   * @case Override referencing an unknown agent name fails loudly
   * @preconditions Override key for an agent that wasn't loaded
   * @expectedResult Throws RC5003 with the offending key
   */
  test("override for an unknown agent throws", async () => {
    const dir = makeDir({
      "x.md": "---\nname: x\ndescription: d\n---\nsystem",
    });
    await expect(agents(dir, { y: { maxTurns: 1 } })).rejects.toThrow(
      /override for "y" but no agent with that name/,
    );
  });
});
