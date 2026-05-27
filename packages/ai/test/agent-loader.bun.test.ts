import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { testContext } from "@routecraft/testing";
import { agentPlugin, agents, tools } from "../src/index.ts";
import { isToolSelection } from "../src/agent/tools/selection.ts";

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
   * @case maxTurns frontmatter passes through
   * @preconditions Agent with maxTurns: 30
   * @expectedResult AgentRegisteredOptions has maxTurns set
   */
  test("maxTurns frontmatter passes through", async () => {
    const dir = makeDir({
      "x.md": "---\nname: x\ndescription: d\nmaxTurns: 30\n---\nsystem prompt",
    });
    const result = await agents(dir);
    expect(result["x"]?.maxTurns).toBe(30);
  });

  /**
   * @case `skills` frontmatter is rejected (replaced by code-side `blocks`)
   * @preconditions Agent frontmatter contains the now-removed `skills:` field
   * @expectedResult Throws RC5003 listing the supported keys (skills not among them)
   */
  test("skills frontmatter is rejected after the 0.6 block rework", async () => {
    const dir = makeDir({
      "x.md":
        "---\nname: x\ndescription: d\nskills:\n  - one\n  - two\n---\nsystem",
    });
    await expect(agents(dir)).rejects.toThrow(
      /frontmatter field "skills" is not yet supported/,
    );
  });

  /**
   * @case principal: true frontmatter passes through as a boolean
   * @preconditions Agent with principal: true
   * @expectedResult AgentRegisteredOptions.principal is the boolean true
   */
  test("principal: true frontmatter passes through", async () => {
    const dir = makeDir({
      "x.md": "---\nname: x\ndescription: d\nprincipal: true\n---\nsystem",
    });
    const result = await agents(dir);
    expect(result["x"]?.principal).toBe(true);
  });

  /**
   * @case principal: false frontmatter passes through (opt-out of a default)
   * @preconditions Agent with principal: false
   * @expectedResult AgentRegisteredOptions.principal is the boolean false so it
   *   overrides any agentPlugin({ defaultOptions: { principal } }) at dispatch
   */
  test("principal: false frontmatter passes through", async () => {
    const dir = makeDir({
      "x.md": "---\nname: x\ndescription: d\nprincipal: false\n---\nsystem",
    });
    const result = await agents(dir);
    expect(result["x"]?.principal).toBe(false);
  });

  /**
   * @case Non-boolean principal frontmatter is rejected
   * @preconditions principal set to a string (a renderer cannot be expressed in YAML)
   * @expectedResult Throws RC5003 telling the user principal must be a boolean
   */
  test("rejects non-boolean principal frontmatter", async () => {
    const dir = makeDir({
      "x.md":
        "---\nname: x\ndescription: d\nprincipal: yes-please\n---\nsystem",
    });
    await expect(agents(dir)).rejects.toThrow(
      /frontmatter field "principal" must be a boolean/,
    );
  });

  /**
   * @case Override supplies the principal renderer that YAML cannot express
   * @preconditions Markdown omits principal; override sets a renderer function
   * @expectedResult Loaded agent.principal is the override function
   */
  test("override can set the principal renderer", async () => {
    const dir = makeDir({
      "x.md": "---\nname: x\ndescription: d\n---\nsystem",
    });
    const renderer = (): string => "## Caller\n\ncustom";
    const result = await agents(dir, { x: { principal: renderer } });
    expect(result["x"]?.principal).toBe(renderer);
  });

  /**
   * @case tools string array in frontmatter is parsed into a tools([...]) selection
   * @preconditions Agent with tools: ["fetchOrder", "Direct(cancel-order)"]
   * @expectedResult agent.tools is a ToolSelection (brand check via isToolSelection) and each entry was forwarded verbatim
   */
  test("tools frontmatter becomes a tools([...]) selection", async () => {
    const dir = makeDir({
      "x.md":
        '---\nname: x\ndescription: d\ntools:\n  - fetchOrder\n  - "Direct(cancel-order)"\n---\nsystem',
    });
    const result = await agents(dir);
    const sel = result["x"]?.tools;
    expect(isToolSelection(sel)).toBe(true);
    // Resolve against an empty context so an unresolvable name throws
    // RC5003 with the offending ref in the message. That confirms the
    // frontmatter entries reached the resolver verbatim rather than
    // being silently mangled at parse time.
    const t = await testContext()
      .with({ plugins: [agentPlugin({})] })
      .build();
    await t.startAndWaitReady();
    try {
      expect(() => sel!.resolve(t.ctx)).toThrow(/unknown tool "fetchOrder"/);
    } finally {
      await t.stop();
    }
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
