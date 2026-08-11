import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { logger } from "@routecraft/routecraft";
import { testContext } from "@routecraft/testing";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { agentPlugin, agents, tools } from "../src/index.ts";
import { loadAgentFiles } from "../src/agent/loader.ts";
import { isToolSelection } from "../src/agent/tools/selection.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rc-agents-"));
}

describe("agents() markdown loader", () => {
  let dirs: string[] = [];
  // Claude-compatibility paths report through the logger rather than
  // throwing, so the warning is the assertion surface.
  let warn: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  /**
   * Write a tree of files under a fresh temp directory. Keys may carry
   * `/` separators to create nested folders, which is what the agent
   * walk cases need.
   */
  function makeDir(files: Record<string, string>): string {
    const dir = tmpDir();
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) {
      const target = join(dir, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf-8");
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
   * @case `skills` frontmatter is accepted and surfaced verbatim, not resolved
   * @preconditions Flat agent declaring a local path and an npm: package ref
   * @expectedResult Load succeeds and LoadedAgentFile.skills carries both refs in declared order
   */
  test("skills frontmatter is surfaced verbatim on the loaded record", async () => {
    const dir = makeDir({
      "x.md":
        "---\nname: x\ndescription: d\nskills:\n  - ./skills\n  - npm:@devoptixnl/claude-skills/devoptix\n---\nsystem",
    });
    const loaded = await loadAgentFiles(dir);
    expect(loaded[0]?.skills).toEqual([
      "./skills",
      "npm:@devoptixnl/claude-skills/devoptix",
    ]);
    // The declaration is not a block: resolving a ref needs the house
    // folder and the bundle folder, which this loader is not given.
    expect((await agents(dir))["x"]?.blocks).toBeUndefined();
  });

  /**
   * @case Non-string entries in the skills list are rejected at load
   * @preconditions skills list holds a mapping instead of a ref string
   * @expectedResult Throws RC5003 naming the skills field
   */
  test("rejects a skills list that is not strings", async () => {
    const dir = makeDir({
      "x.md": "---\nname: x\ndescription: d\nskills:\n  - a: b\n---\nsystem",
    });
    await expect(agents(dir)).rejects.toThrow(
      /frontmatter field "skills" must contain only non-empty strings/,
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
   * @case Override supplies the output schema that YAML cannot express
   * @preconditions Markdown omits output; override sets a Standard Schema
   * @expectedResult Loaded agent.output is the override schema (override-only, mirroring blocks)
   */
  test("override can set the output schema", async () => {
    const dir = makeDir({
      "x.md": "---\nname: x\ndescription: d\n---\nsystem",
    });
    const schema: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) => ({ value }),
      },
    };
    const result = await agents(dir, { x: { output: schema } });
    expect(result["x"]?.output).toBe(schema);
  });

  /**
   * @case output in frontmatter is rejected as override-only
   * @preconditions Agent with an output key in YAML (a schema cannot be expressed there)
   * @expectedResult Throws RC5003 pointing at the override map, not the generic not-yet-supported error
   */
  test("rejects output frontmatter as override-only", async () => {
    const dir = makeDir({
      "x.md": "---\nname: x\ndescription: d\noutput: json\n---\nsystem",
    });
    await expect(agents(dir)).rejects.toThrow(
      /frontmatter field "output" is override-only.*agents\(path, \{ "x": \{ output: \.\.\. \} \}\)/,
    );
  });

  /**
   * @case blocks in frontmatter is rejected as override-only
   * @preconditions Agent with a blocks key in YAML (resolvers may carry functions YAML cannot express)
   * @expectedResult Throws RC5003 pointing at the override map, not the generic not-yet-supported error
   */
  test("rejects blocks frontmatter as override-only", async () => {
    const dir = makeDir({
      "x.md": "---\nname: x\ndescription: d\nblocks: {}\n---\nsystem",
    });
    await expect(agents(dir)).rejects.toThrow(
      /frontmatter field "blocks" is override-only/,
    );
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
   * @case Claude-specific frontmatter this loader does not map is tolerated
   * @preconditions Agent carrying permissionMode and color
   * @expectedResult The agent loads and each ignored key is warned about
   */
  test("ignores unmapped Claude frontmatter with a warning", async () => {
    const dir = makeDir({
      "x.md":
        "---\nname: x\ndescription: d\npermissionMode: default\ncolor: blue\n---\nsystem",
    });
    const result = await agents(dir);
    expect(result["x"]?.description).toBe("d");
    const warned = warn.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(warned).toMatch(/"permissionMode" is not supported/);
    expect(warned).toMatch(/"color" is not supported/);
  });

  /**
   * @case Claude model aliases map to full provider:model references
   * @preconditions model: sonnet
   * @expectedResult The agent carries the pinned anthropic reference
   */
  test("maps the model alias 'sonnet'", async () => {
    const dir = makeDir({
      "x.md": "---\nname: x\ndescription: d\nmodel: sonnet\n---\nsystem",
    });
    const result = await agents(dir);
    expect(result["x"]?.model).toBe("anthropic:claude-sonnet-4-6");
  });

  /**
   * @case model: inherit leaves the model unset so the context default applies
   * @preconditions model: inherit
   * @expectedResult No model on the loaded agent
   */
  test("maps the model alias 'inherit' to no model at all", async () => {
    const dir = makeDir({
      "x.md": "---\nname: x\ndescription: d\nmodel: inherit\n---\nsystem",
    });
    const result = await agents(dir);
    expect(result["x"]?.model).toBeUndefined();
  });

  /**
   * @case A model that is neither an alias nor provider:model is rejected
   * @preconditions model: gpt-nine
   * @expectedResult Throws RC5003 listing the known aliases
   */
  test("rejects a model that is neither alias nor provider:model", async () => {
    const dir = makeDir({
      "x.md": "---\nname: x\ndescription: d\nmodel: gpt-nine\n---\nsystem",
    });
    await expect(agents(dir)).rejects.toThrow(
      /neither a known alias .* nor a full "provider:model" reference/,
    );
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

  /**
   * @case Subdirectories are grouping folders and are walked recursively
   * @preconditions Agents at the root, one level down, and two levels down
   * @expectedResult All three load; the directory path contributes nothing to identity
   */
  test("walks subdirectories recursively", async () => {
    const dir = makeDir({
      "triage.md": "---\nname: triage\ndescription: d\n---\nsystem",
      "review/security.md": "---\nname: security\ndescription: d\n---\nsystem",
      "research/deep/market.md":
        "---\nname: market\ndescription: d\n---\nsystem",
    });
    const result = await agents(dir);
    expect(Object.keys(result).sort()).toEqual([
      "market",
      "security",
      "triage",
    ]);
  });

  /**
   * @case Identity comes from frontmatter name, not the filename
   * @preconditions File named 01-first.md declaring name: triage
   * @expectedResult Agent is registered as "triage"; the filename is not consulted
   */
  test("agent name comes from frontmatter, not the filename", async () => {
    const dir = makeDir({
      "01-first.md": "---\nname: triage\ndescription: d\n---\nsystem",
    });
    const result = await agents(dir);
    expect(Object.keys(result)).toEqual(["triage"]);
  });

  /**
   * @case Two files declaring the same name fail loudly rather than shadowing
   * @preconditions Same name in a root file and a nested file
   * @expectedResult Throws RC5003 naming both source paths
   */
  test("duplicate agent names across the tree throw", async () => {
    const dir = makeDir({
      "triage.md": "---\nname: triage\ndescription: d\n---\nsystem",
      "inbox/other.md": "---\nname: triage\ndescription: d\n---\nsystem",
    });
    const error = await agents(dir).catch((err: unknown) => err);
    expect(error).toMatchObject({ rc: "RC5003" });
    expect((error as Error).message).toMatch(/duplicate agent name "triage"/);
    expect((error as Error).message).toContain("triage.md");
    expect((error as Error).message).toContain(join("inbox", "other.md"));
  });

  /**
   * @case A directory holding AGENT.md is one agent and is not descended into
   * @preconditions Bundle aria/AGENT.md alongside aria/notes/scratch.md
   * @expectedResult Only "aria" loads; the nested markdown never becomes an agent
   */
  test("AGENT.md bundle loads as exactly one agent", async () => {
    const dir = makeDir({
      "aria/AGENT.md": "---\nname: aria\ndescription: d\n---\nsystem",
      "aria/notes/scratch.md": "not an agent at all",
    });
    const loaded = await loadAgentFiles(dir);
    expect(loaded.map((a) => a.name)).toEqual(["aria"]);
    expect(loaded[0]?.bundleDirectory).toBe(join(dir, "aria"));
  });

  /**
   * @case A bundle whose frontmatter name differs from its directory is an error
   * @preconditions aria/AGENT.md declaring name: nova
   * @expectedResult Throws RC5003 naming both the declared name and the directory name
   */
  test("bundle name must match the bundle directory", async () => {
    const dir = makeDir({
      "aria/AGENT.md": "---\nname: nova\ndescription: d\n---\nsystem",
    });
    const error = await agents(dir).catch((err: unknown) => err);
    expect(error).toMatchObject({ rc: "RC5003" });
    expect((error as Error).message).toMatch(/"nova"/);
    expect((error as Error).message).toMatch(/"aria"/);
  });

  /**
   * @case Markdown inside a bundle never fails the boot, whatever it contains
   * @preconditions Bundle whose skills/ holds a skill and a file with no frontmatter
   * @expectedResult Only the bundle agent loads. The bundle rule alone accounts
   *   for this (the walk stops at AGENT.md and never descends), which is why the
   *   reserved-directory rule is covered separately below.
   */
  test("markdown inside a bundle is never loaded as an agent", async () => {
    const dir = makeDir({
      "aria/AGENT.md": "---\nname: aria\ndescription: d\n---\nsystem",
      "aria/skills/refund-policy.md":
        "---\nname: refund-policy\ndescription: d\n---\nRefund rules.",
      "aria/skills/nested/notes.md": "no frontmatter at all",
    });
    const result = await agents(dir);
    expect(Object.keys(result)).toEqual(["aria"]);
  });

  /**
   * @case The skills directory is reserved at every depth, not only inside a bundle
   * @preconditions A skills/ folder at the agents root and another under a
   *   grouping folder, neither of them a bundle, so only the reserved-directory
   *   rule can skip them
   * @expectedResult Only the real agent loads. Dropping the reservation makes
   *   this fail loudly rather than quietly: the nested file has no description,
   *   so it would throw if the walk ever treated it as an agent.
   */
  test("a skills directory is reserved at any depth", async () => {
    const dir = makeDir({
      "triage.md": "---\nname: triage\ndescription: d\n---\nsystem",
      "skills/tone-of-voice.md":
        "---\nname: tone-of-voice\ndescription: d\n---\nBe brief.",
      "team/skills/handbook.md": "---\nname: handbook\n---\nno description",
    });
    const result = await agents(dir);
    expect(Object.keys(result)).toEqual(["triage"]);
  });

  /**
   * @case An AGENT.md bundle may declare skills refs like a flat file
   * @preconditions Bundle frontmatter carrying a local ref and an npm: ref
   * @expectedResult Refs are surfaced verbatim alongside the bundle directory
   */
  test("skills frontmatter is surfaced from a bundle too", async () => {
    const dir = makeDir({
      "zoe/AGENT.md":
        "---\nname: zoe\ndescription: d\nskills:\n  - ./skills\n  - npm:@devoptixnl/claude-skills/devoptix\n---\nsystem",
    });
    const loaded = await loadAgentFiles(dir);
    expect(loaded[0]).toMatchObject({
      name: "zoe",
      skills: ["./skills", "npm:@devoptixnl/claude-skills/devoptix"],
    });
  });

  /**
   * @case An existing Claude Code agents tree loads with no edits
   * @preconditions Nested folders, filenames that differ from the declared names
   * @expectedResult Every agent loads keyed by its frontmatter name
   */
  test("an existing .claude/agents tree loads unmodified", async () => {
    const dir = makeDir({
      "review/security-reviewer.md":
        "---\nname: security\ndescription: Reviews for vulnerabilities\n---\nYou review code.",
      "review/perf.md":
        "---\nname: performance\ndescription: Reviews for hot paths\n---\nYou profile code.",
      "research/market.md":
        "---\nname: market-research\ndescription: Researches markets\n---\nYou research.",
    });
    const result = await agents(dir);
    expect(Object.keys(result).sort()).toEqual([
      "market-research",
      "performance",
      "security",
    ]);
  });

  /**
   * @case A symlinked subdirectory is not followed, so a cyclic tree terminates
   * @preconditions agents/loop is a symlink pointing back at the agents root
   * @expectedResult The load completes and yields only the real agent
   */
  test("does not follow a symlinked directory", async () => {
    const dir = makeDir({
      "triage.md": "---\nname: triage\ndescription: d\n---\nsystem",
    });
    symlinkSync(dir, join(dir, "loop"), "dir");
    const result = await agents(dir);
    expect(Object.keys(result)).toEqual(["triage"]);
  });

  /**
   * @case A symlinked markdown file is followed
   * @preconditions agents/linked.md is a symlink to a real agent file elsewhere
   * @expectedResult The agent loads, keyed by its frontmatter name
   */
  test("follows a symlinked markdown file", async () => {
    const root = makeDir({
      "shared/shared.md": "---\nname: shared\ndescription: d\n---\nsystem",
      "agents/triage.md": "---\nname: triage\ndescription: d\n---\nsystem",
    });
    symlinkSync(
      join(root, "shared", "shared.md"),
      join(root, "agents", "linked.md"),
    );
    const result = await agents(join(root, "agents"));
    expect(Object.keys(result).sort()).toEqual(["shared", "triage"]);
  });

  /**
   * @case A single-file path is recognised whatever the extension's case
   * @preconditions An agent file named with an uppercase .MD extension
   * @expectedResult It loads as one agent rather than being treated as a directory
   */
  test("accepts a single file with an uppercase extension", async () => {
    const dir = makeDir({
      "Triage.MD": "---\nname: triage\ndescription: d\n---\nsystem",
    });
    const result = await agents(join(dir, "Triage.MD"));
    expect(Object.keys(result)).toEqual(["triage"]);
  });

  /**
   * @case A directory whose name ends in .md is walked, not read as a file
   * @preconditions An agents directory literally named "inbox.md"
   * @expectedResult Its contents load, rather than the read failing with EISDIR
   */
  test("classifies a source by filesystem type, not by extension", async () => {
    const root = makeDir({
      "inbox.md/triage.md": "---\nname: triage\ndescription: d\n---\nsystem",
    });
    const result = await agents(join(root, "inbox.md"));
    expect(Object.keys(result)).toEqual(["triage"]);
  });

  /**
   * @case A file that is not markdown is rejected with a sentence
   * @preconditions A path to a .txt file
   * @expectedResult Throws RC5003 saying it is a file but not a .md file
   */
  test("rejects a single file that is not markdown", async () => {
    const root = makeDir({ "notes.txt": "not markdown" });
    await expect(agents(join(root, "notes.txt"))).rejects.toThrow(
      /is a file but not a "\.md" file/,
    );
  });

  /**
   * Resolve an agent's tool selection against a context holding the
   * given fns, returning the resolved wire names.
   */
  async function resolveToolNames(
    agent: { tools?: unknown } | undefined,
    functions: Record<string, unknown> = {},
  ): Promise<string[]> {
    const t = await testContext()
      .with({
        plugins: [
          agentPlugin({
            functions: functions as NonNullable<
              NonNullable<Parameters<typeof agentPlugin>[0]>["functions"]
            >,
          }),
        ],
      })
      .build();
    await t.startAndWaitReady();
    try {
      const selection = agent?.tools as
        { resolve: (ctx: unknown) => Array<{ name: string }> } | undefined;
      return (selection?.resolve(t.ctx) ?? []).map((tool) => tool.name).sort();
    } finally {
      await t.stop();
    }
  }

  const echoFn = {
    description: "Echoes",
    input: {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (value: unknown) => ({ value }),
      },
    },
    handler: async (): Promise<string> => "ok",
  };

  /**
   * @case Claude's comma-separated tools string is accepted
   * @preconditions tools: echo, Read written as a plain string
   * @expectedResult Both refs are parsed; the registered fn resolves
   */
  test("accepts a comma-separated tools string", async () => {
    const dir = makeDir({
      "x.md": "---\nname: x\ndescription: d\ntools: echo, Read\n---\nsystem",
    });
    const result = await agents(dir);
    expect(await resolveToolNames(result["x"], { echo: echoFn })).toEqual([
      "echo",
    ]);
  });

  /**
   * @case A Claude built-in this runtime does not provide is skipped with a warning
   * @preconditions tools listing Read alongside a registered fn
   * @expectedResult Only the registered fn resolves; the skip is warned once
   */
  test("skips Claude built-ins this runtime does not provide", async () => {
    const dir = makeDir({
      "x.md":
        "---\nname: x\ndescription: d\ntools:\n  - echo\n  - Read\n  - Bash\n---\nsystem",
    });
    const result = await agents(dir);
    expect(await resolveToolNames(result["x"], { echo: echoFn })).toEqual([
      "echo",
    ]);
    const warned = warn.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(warned).toMatch(/tool "Read" is a Claude Code built-in/);
    expect(warned).toMatch(/tool "Bash" is a Claude Code built-in/);
  });

  /**
   * @case A registered fn wins over the built-in skip list
   * @preconditions A fn actually registered under the name Read
   * @expectedResult It resolves normally rather than being skipped
   */
  test("a registered fn named like a built-in resolves normally", async () => {
    const dir = makeDir({
      "x.md": "---\nname: x\ndescription: d\ntools:\n  - Read\n---\nsystem",
    });
    const result = await agents(dir);
    expect(await resolveToolNames(result["x"], { Read: echoFn })).toEqual([
      "Read",
    ]);
  });

  /**
   * @case A genuinely unknown tool name is still a hard error
   * @preconditions tools listing a name that is neither registered nor a Claude built-in
   * @expectedResult Resolution throws naming the unknown tool
   */
  test("a genuinely unknown tool still throws", async () => {
    const dir = makeDir({
      "x.md":
        "---\nname: x\ndescription: d\ntools:\n  - notAThing\n---\nsystem",
    });
    const result = await agents(dir);
    await expect(resolveToolNames(result["x"])).rejects.toThrow(
      /unknown tool "notAThing"/,
    );
  });

  /**
   * @case disallowedTools removes a reference from the agent's own list
   * @preconditions tools grants two fns; disallowedTools denies one
   * @expectedResult Only the allowed fn resolves
   */
  test("disallowedTools removes a granted tool", async () => {
    const dir = makeDir({
      "x.md":
        "---\nname: x\ndescription: d\ntools: echo, other\ndisallowedTools: other\n---\nsystem",
    });
    const result = await agents(dir);
    expect(
      await resolveToolNames(result["x"], { echo: echoFn, other: echoFn }),
    ).toEqual(["echo"]);
  });

  /**
   * @case A deny list with no allow list fails the load rather than failing open
   * @preconditions Only disallowedTools is set, so the agent would inherit the
   *   context default including the tools the file denies
   * @expectedResult Throws RC5003 explaining why it cannot be honoured and what
   *   to write instead
   */
  test("disallowedTools without tools throws", async () => {
    const dir = makeDir({
      "x.md":
        "---\nname: x\ndescription: d\ndisallowedTools: Bash\n---\nsystem",
    });
    const error = await agents(dir).catch((err: unknown) => err);
    expect(error).toMatchObject({ rc: "RC5003" });
    expect((error as Error).message).toMatch(
      /deny list alone cannot be honoured/,
    );
  });

  /**
   * @case A model naming an Object.prototype member is rejected
   * @preconditions model: constructor, which a bare table lookup would resolve
   *   to a function off the prototype chain
   * @expectedResult Throws RC5003 rather than accepting a function as a model id
   */
  test("rejects a model that names a prototype member", async () => {
    const dir = makeDir({
      "x.md": "---\nname: x\ndescription: d\nmodel: constructor\n---\nsystem",
    });
    await expect(agents(dir)).rejects.toThrow(
      /neither a known alias .* nor a full "provider:model" reference/,
    );
  });

  /**
   * @case A real Claude Code agents tree boots unchanged
   * @preconditions Nested folders, Claude-only frontmatter, comma-separated tools
   *   mixing a built-in with an MCP ref, filenames differing from declared names
   * @expectedResult Every agent loads keyed by frontmatter name with aliases mapped,
   *   unknown keys warned, and the unimplemented built-in skipped
   */
  test("a real .claude/agents tree boots unchanged", async () => {
    const dir = makeDir({
      "review/security-reviewer.md": [
        "---",
        "name: security",
        "description: Reviews for vulnerabilities",
        "model: opus",
        "tools: Read, Grep, echo",
        "color: red",
        "permissionMode: default",
        "---",
        "You review code.",
      ].join("\n"),
      "research/market.md": [
        "---",
        "name: market-research",
        "description: Researches markets",
        "model: haiku",
        "disallowedTools: Write",
        "tools: WebSearch, echo",
        "---",
        "You research.",
      ].join("\n"),
    });
    const result = await agents(dir);
    expect(Object.keys(result).sort()).toEqual(["market-research", "security"]);
    expect(result["security"]?.model).toBe("anthropic:claude-opus-4-7");
    expect(result["market-research"]?.model).toBe("anthropic:claude-haiku-4-5");
    expect(
      await resolveToolNames(result["security"], { echo: echoFn }),
    ).toEqual(["echo"]);
    expect(
      await resolveToolNames(result["market-research"], { echo: echoFn }),
    ).toEqual(["echo"]);
  });

  /**
   * @case Dependency and dot directories are never walked
   * @preconditions node_modules/ and .cache/ under the agents root holding markdown
   * @expectedResult Only the real agent loads; a package tree is not scanned for agents
   */
  test("skips node_modules and dot directories", async () => {
    const dir = makeDir({
      "triage.md": "---\nname: triage\ndescription: d\n---\nsystem",
      "node_modules/pkg/readme.md": "# not an agent",
      ".cache/tmp.md": "# not an agent",
    });
    const result = await agents(dir);
    expect(Object.keys(result)).toEqual(["triage"]);
  });
});
