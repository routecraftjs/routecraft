import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  getProjectDiscoverers,
  logger,
  type CraftConfig,
  type ProjectDiscoverer,
} from "@routecraft/routecraft";
import { tools } from "../src/index.ts";
import type { AgentRegisteredOptions } from "../src/agent/types.ts";
import type { BlockBody, Blocks } from "../src/block/types.ts";

// Importing the package entry registers the discoverers as a side effect.
import "../src/index.ts";

function discovererFor(folder: string): ProjectDiscoverer {
  const found = getProjectDiscoverers().find((d) => d.folder === folder);
  if (!found) throw new Error(`no discoverer registered for "${folder}"`);
  return found.discover;
}

function skillFile(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: The ${name} skill\n---\n${body}`;
}

function agentFile(name: string, frontmatter = ""): string {
  return `---\nname: ${name}\ndescription: The ${name} agent\n${frontmatter}---\nYou are ${name}.`;
}

/** Names of the leaves inside a resolved `skills` block group. */
function skillNames(agent: AgentRegisteredOptions | undefined): string[] {
  const group = agent?.blocks?.["skills"];
  if (!group || typeof group !== "object") return [];
  return Object.keys(group as Blocks).sort();
}

function skillBody(
  agent: AgentRegisteredOptions | undefined,
  name: string,
): string | undefined {
  const group = agent?.blocks?.["skills"] as Blocks | undefined;
  const leaf = group?.[name];
  if (!leaf) return undefined;
  const value = (leaf as BlockBody).value;
  return typeof value === "string" ? value : undefined;
}

describe("project discoverers", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  /** Write a tree of files under a fresh temp project root. */
  function makeProject(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "rc-project-"));
    dirs.push(root);
    for (const [name, content] of Object.entries(files)) {
      const target = join(root, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf-8");
    }
    return root;
  }

  /** Run skills then agents, threading the config the way `start` does. */
  async function discover(
    root: string,
    config: CraftConfig = {},
  ): Promise<CraftConfig> {
    const { mergeProjectConfig } = await import("@routecraft/routecraft");
    let out = config;
    for (const folder of ["skills", "agents"]) {
      const directory = join(root, folder);
      // `craft start` only invokes a discoverer for a folder that
      // exists; mirror that so a project without one is not an error.
      if (!existsSync(directory)) continue;
      out = mergeProjectConfig(
        out,
        await discovererFor(folder)({
          directory,
          contentRoot: root,
          projectRoot: root,
          config: out,
          declared: config,
        }),
      );
    }
    return out;
  }

  /**
   * @case The house skills folder becomes the default skill group
   * @preconditions skills/ holds a flat skill and a nested SKILL.md bundle
   * @expectedResult Both land under agent.defaultOptions.blocks.skills
   */
  test("house skills load into the agent defaults", async () => {
    const root = makeProject({
      "skills/tone-of-voice.md": skillFile("tone-of-voice", "Be brief."),
      "skills/incident-response/SKILL.md": skillFile(
        "incident-response",
        "Page someone.",
      ),
      "agents/triage.md": agentFile("triage"),
    });
    const config = await discover(root);
    const house = config.agent?.defaultOptions?.blocks?.["skills"] as Blocks;
    expect(Object.keys(house).sort()).toEqual([
      "incident-response",
      "tone-of-voice",
    ]);
  });

  /**
   * @case An agent with no skills declaration inherits the house set
   * @preconditions Dropped-in agent file with no skills: key, house folder present
   * @expectedResult The agent carries no own skills block, so the default applies
   */
  test("an agent without a skills key inherits the house default", async () => {
    const root = makeProject({
      "skills/tone-of-voice.md": skillFile("tone-of-voice", "Be brief."),
      "agents/triage.md": agentFile("triage"),
    });
    const config = await discover(root);
    // An empty own group would replace the default wholesale and leave
    // the agent with nothing; absent is what makes it inherit.
    expect(
      config.agent?.agents?.["triage"]?.blocks?.["skills"],
    ).toBeUndefined();
  });

  /**
   * @case A bundle's own skills folder composes on top of the house set
   * @preconditions House skill plus a bundle with its own skills/ folder
   * @expectedResult The agent sees the union of both
   */
  test("a bundle composes house and bundle skills", async () => {
    const root = makeProject({
      "skills/tone-of-voice.md": skillFile("tone-of-voice", "Be brief."),
      "agents/aria/AGENT.md": agentFile("aria"),
      "agents/aria/skills/refund-policy.md": skillFile(
        "refund-policy",
        "Refund rules.",
      ),
    });
    const config = await discover(root);
    expect(skillNames(config.agent?.agents?.["aria"])).toEqual([
      "refund-policy",
      "tone-of-voice",
    ]);
  });

  /**
   * @case The most specific source wins a name collision
   * @preconditions A skill name present in both the house folder and the bundle
   * @expectedResult The bundle's body is the one the agent gets
   */
  test("a bundle skill shadows the house skill of the same name", async () => {
    const root = makeProject({
      "skills/tone-of-voice.md": skillFile("tone-of-voice", "House tone."),
      "agents/aria/AGENT.md": agentFile("aria"),
      "agents/aria/skills/tone-of-voice.md": skillFile(
        "tone-of-voice",
        "Aria tone.",
      ),
    });
    const config = await discover(root);
    expect(skillBody(config.agent?.agents?.["aria"], "tone-of-voice")).toBe(
      "Aria tone.",
    );
  });

  /**
   * @case Frontmatter refs resolve as local paths relative to the agent file
   * @preconditions Flat agent declaring skills: ../shared-skills
   * @expectedResult The referenced folder's skills compose onto the house set
   */
  test("a local skills ref resolves relative to the agent file", async () => {
    const root = makeProject({
      "skills/tone-of-voice.md": skillFile("tone-of-voice", "Be brief."),
      "shared-skills/escalation.md": skillFile("escalation", "Escalate."),
      "agents/triage.md": agentFile(
        "triage",
        "skills:\n  - ../shared-skills\n",
      ),
    });
    const config = await discover(root);
    expect(skillNames(config.agent?.agents?.["triage"])).toEqual([
      "escalation",
      "tone-of-voice",
    ]);
  });

  /**
   * @case Composition order is house, then frontmatter refs, then bundle
   * @preconditions One skill name declared in all three sources
   * @expectedResult The bundle copy wins, proving it is applied last
   */
  test("composition order runs house then refs then bundle", async () => {
    const root = makeProject({
      "skills/policy.md": skillFile("policy", "House."),
      "extra/policy.md": skillFile("policy", "Ref."),
      "agents/aria/AGENT.md": agentFile("aria", "skills:\n  - ../../extra\n"),
      "agents/aria/skills/policy.md": skillFile("policy", "Bundle."),
    });
    const config = await discover(root);
    expect(skillBody(config.agent?.agents?.["aria"], "policy")).toBe("Bundle.");
  });

  /**
   * @case An unresolvable local ref fails the boot with a typed error
   * @preconditions skills: ./nope pointing at a folder that does not exist
   * @expectedResult Throws AI1004 naming the ref
   */
  test("an unresolvable skills ref throws AI1004", async () => {
    const root = makeProject({
      "agents/triage.md": agentFile("triage", "skills:\n  - ./nope\n"),
    });
    const error = await discover(root).catch((err: unknown) => err);
    expect(error).toMatchObject({ rc: "AI1004" });
    expect((error as Error).message).toMatch(/\.\/nope/);
  });

  /**
   * @case A config-set blocks.skills stops the frontmatter refs being resolved at all
   * @preconditions The config declares the agent's blocks.skills, and the same
   *   agent's frontmatter carries a ref that would fail to resolve
   * @expectedResult The boot succeeds with the config's skills, because code
   *   winning has to mean the ignored path is never walked, not merely that
   *   its result is discarded after it has already thrown
   */
  test("a configured blocks.skills suppresses ref resolution entirely", async () => {
    const root = makeProject({
      "agents/triage.md": agentFile("triage", "skills:\n  - ./nope\n"),
    });
    const config = await discover(root, {
      agent: {
        agents: {
          triage: {
            description: "Declared in code",
            system: "You are triage.",
            blocks: { skills: { house: { mode: "inject", value: "Config." } } },
          },
        },
      },
    });
    expect(skillBody(config.agent?.agents?.["triage"], "house")).toBe(
      "Config.",
    );
  });

  /**
   * @case An npm: ref that is not a package name is rejected before resolution
   * @preconditions skills: npm:.., which Node would otherwise resolve relatively
   * @expectedResult Throws AI1004, so the npm: form cannot be used to reach a
   *   directory outside the installed dependency set
   */
  test("an npm: ref that is not a package name throws AI1004", async () => {
    const root = makeProject({
      "agents/triage.md": agentFile("triage", "skills:\n  - npm:..\n"),
    });
    const error = await discover(root).catch((err: unknown) => err);
    expect(error).toMatchObject({ rc: "AI1004" });
    expect((error as Error).message).toMatch(/is not a package name/);
  });

  /**
   * @case An npm: subpath climbing out of the package root is rejected
   * @preconditions An installed package plus a ref whose subpath is ../../outside
   * @expectedResult Throws AI1004 naming the package root, so a ref cannot read
   *   a directory the dependency does not own
   */
  test("an npm: subpath escaping the package root throws AI1004", async () => {
    const root = makeProject({
      "node_modules/@acme/house/package.json": JSON.stringify({
        name: "@acme/house",
        version: "1.0.0",
      }),
      "node_modules/@acme/house/skills/policy.md": skillFile("policy", "Pkg."),
      "agents/zoe.md": agentFile(
        "zoe",
        "skills:\n  - npm:@acme/house/../../outside\n",
      ),
    });
    const error = await discover(root).catch((err: unknown) => err);
    expect(error).toMatchObject({ rc: "AI1004" });
    expect((error as Error).message).toMatch(/points outside the package root/);
  });

  /**
   * @case An npm: ref names a package that is not installed
   * @preconditions skills: npm:@nope/not-installed
   * @expectedResult Throws AI1004 with an install hint naming the package
   */
  test("an uninstalled skills package throws AI1004 with an install hint", async () => {
    const root = makeProject({
      "agents/triage.md": agentFile(
        "triage",
        "skills:\n  - npm:@nope/not-installed\n",
      ),
    });
    const error = await discover(root).catch((err: unknown) => err);
    expect(error).toMatchObject({ rc: "AI1004" });
    expect((error as Error).message).toMatch(/bun add @nope\/not-installed/);
  });

  /**
   * @case An npm: ref with a subpath resolves against the package root
   * @preconditions A claude-skills-shaped package installed in node_modules,
   *   holding its collections as plain subdirectories
   * @expectedResult The subpath's skills compose onto the agent
   */
  test("an npm: ref resolves a plain subpath in the package", async () => {
    const root = makeProject({
      "node_modules/@acme/claude-skills/package.json": JSON.stringify({
        name: "@acme/claude-skills",
        version: "1.0.0",
      }),
      "node_modules/@acme/claude-skills/devoptix/handbook.md": skillFile(
        "handbook",
        "The handbook.",
      ),
      "agents/zoe.md": agentFile(
        "zoe",
        "skills:\n  - npm:@acme/claude-skills/devoptix\n",
      ),
    });
    const config = await discover(root);
    expect(skillNames(config.agent?.agents?.["zoe"])).toEqual(["handbook"]);
  });

  /**
   * @case An npm: ref with no subpath falls back to the package's skills root
   * @preconditions Package keeping its skills under a well-known skills/ folder
   * @expectedResult The skills/ folder is used without naming it in the ref
   */
  test("an npm: ref with no subpath uses the package skills folder", async () => {
    const root = makeProject({
      "node_modules/@acme/house/package.json": JSON.stringify({
        name: "@acme/house",
        version: "1.0.0",
      }),
      "node_modules/@acme/house/skills/brand.md": skillFile("brand", "Brand."),
      "agents/zoe.md": agentFile("zoe", "skills:\n  - npm:@acme/house\n"),
    });
    const config = await discover(root);
    expect(skillNames(config.agent?.agents?.["zoe"])).toEqual(["brand"]);
  });

  /**
   * @case An agent declared in code keeps its own fields
   * @preconditions Config declares the agent with tools and a custom description
   * @expectedResult The config's fields survive discovery untouched
   */
  test("a config-declared agent keeps its fields", async () => {
    const root = makeProject({
      "agents/zoe.md": agentFile("zoe"),
    });
    const selection = tools(["something"]);
    const config = await discover(root, {
      agent: {
        agents: {
          zoe: {
            description: "From config",
            system: "Config system",
            tools: selection,
          },
        },
      },
    });
    expect(config.agent?.agents?.["zoe"]).toMatchObject({
      description: "From config",
      system: "Config system",
    });
    expect(config.agent?.agents?.["zoe"]?.tools).toBe(selection);
  });

  /**
   * @case A config override that sets only tools leaves frontmatter skills intact
   * @preconditions Config declares zoe with tools only; her frontmatter declares skills
   * @expectedResult Discovery resolves the refs onto her, and the tools object survives
   */
  test("a tools-only override still gets frontmatter-declared skills", async () => {
    const root = makeProject({
      "skills/tone-of-voice.md": skillFile("tone-of-voice", "Be brief."),
      "devoptix/handbook.md": skillFile("handbook", "The handbook."),
      "agents/zoe.md": agentFile("zoe", "skills:\n  - ../devoptix\n"),
    });
    const selection = tools(["something"]);
    const config = await discover(root, {
      agent: {
        agents: {
          zoe: {
            description: "Zoe",
            system: "You are Zoe.",
            tools: selection,
          },
        },
      },
    });
    expect(skillNames(config.agent?.agents?.["zoe"])).toEqual([
      "handbook",
      "tone-of-voice",
    ]);
    expect(config.agent?.agents?.["zoe"]?.tools).toBe(selection);
  });

  /**
   * @case The startup log names which side each field of a merged agent came from
   * @preconditions Config declares zoe with tools; her frontmatter adds a local
   *   ref and a package ref on top of the house folder
   * @expectedResult One info line names the config-set fields and every source
   *   that fed blocks.skills, in composition order
   */
  test("logs field provenance for a merged agent", async () => {
    const info = spyOn(logger, "info").mockImplementation(() => {});
    try {
      const root = makeProject({
        "node_modules/@acme/claude-skills/package.json": JSON.stringify({
          name: "@acme/claude-skills",
          version: "1.0.0",
        }),
        "node_modules/@acme/claude-skills/support/refunds.md": skillFile(
          "refunds",
          "Refunds.",
        ),
        "skills/tone-of-voice.md": skillFile("tone-of-voice", "Be brief."),
        "devoptix/handbook.md": skillFile("handbook", "The handbook."),
        "agents/zoe.md": agentFile(
          "zoe",
          "skills:\n  - ../devoptix\n  - npm:@acme/claude-skills/support\n",
        ),
      });
      await discover(root, {
        agent: {
          agents: {
            zoe: {
              description: "Zoe",
              system: "You are Zoe.",
              tools: tools(["something"]),
            },
          },
        },
      });
      const line = info.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .find((message) => message.startsWith('Agent "zoe"'));
      expect(line).toBe(
        'Agent "zoe": description, system, tools from craft.config.ts, ' +
          "blocks.skills from agents/zoe.md + skills + devoptix + " +
          "npm:@acme/claude-skills/support.",
      );
    } finally {
      info.mockRestore();
    }
  });

  /**
   * @case A config-set blocks.skills is not overwritten by discovery
   * @preconditions Config declares zoe with her own blocks.skills; frontmatter also declares refs
   * @expectedResult The config's block group is the one that survives
   */
  test("a config-set blocks.skills wins over frontmatter refs", async () => {
    const root = makeProject({
      "devoptix/handbook.md": skillFile("handbook", "The handbook."),
      "agents/zoe.md": agentFile("zoe", "skills:\n  - ../devoptix\n"),
    });
    const config = await discover(root, {
      agent: {
        agents: {
          zoe: {
            description: "Zoe",
            system: "You are Zoe.",
            blocks: {
              skills: {
                curated: { mode: "inject", value: "Curated." },
              },
            },
          },
        },
      },
    });
    expect(skillNames(config.agent?.agents?.["zoe"])).toEqual(["curated"]);
  });

  /**
   * @case A config-set house skill group stops the folder from loading
   * @preconditions Config sets agent.defaultOptions.blocks.skills and skills/ exists
   * @expectedResult The config's group survives; the folder is not read
   */
  test("config-set house skills win over the skills folder", async () => {
    const root = makeProject({
      "skills/tone-of-voice.md": skillFile("tone-of-voice", "Be brief."),
      "agents/triage.md": agentFile("triage"),
    });
    const config = await discover(root, {
      agent: {
        defaultOptions: {
          blocks: {
            skills: { curated: { mode: "inject", value: "Curated." } },
          },
        },
      },
    });
    const house = config.agent?.defaultOptions?.blocks?.["skills"] as Blocks;
    expect(Object.keys(house)).toEqual(["curated"]);
  });
});
