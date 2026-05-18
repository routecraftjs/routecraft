import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { skills } from "../src/skill/index.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rc-skills-"));
}

describe("skills() markdown loader", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  function makeDir(files: Record<string, string>): string {
    const dir = tmpDir();
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) {
      const filePath = join(dir, name);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, "utf-8");
    }
    return dir;
  }

  /**
   * @case Loads multiple .md files in a directory into a Record keyed by name
   * @preconditions Two well-formed skill files
   * @expectedResult Returns both skills with content from the body
   */
  test("loads a directory of skill markdown files", async () => {
    const dir = makeDir({
      "web-search.md":
        "---\nname: web-search\ndescription: Search the web\n---\nUse a search engine first.",
      "cite-sources.md":
        "---\nname: cite-sources\ndescription: Cite your sources\n---\nAlways include citations.",
    });
    const result = await skills(dir);
    expect(Object.keys(result).sort()).toEqual(["cite-sources", "web-search"]);
    expect(result["web-search"]).toEqual({
      name: "web-search",
      description: "Search the web",
      content: "Use a search engine first.",
    });
  });

  /**
   * @case Single .md file path also works
   * @preconditions A single skill markdown file
   * @expectedResult Returns one entry keyed by filename
   */
  test("loads a single .md file path", async () => {
    const dir = makeDir({
      "rules.md":
        "---\nname: rules\ndescription: The rules\n---\nRule one. Rule two.",
    });
    const result = await skills(join(dir, "rules.md"));
    expect(result).toEqual({
      rules: {
        name: "rules",
        description: "The rules",
        content: "Rule one. Rule two.",
      },
    });
  });

  /**
   * @case Frontmatter name must match filename
   * @preconditions File "x.md" with frontmatter name "y"
   * @expectedResult Throws RC5003 mentioning the mismatch
   */
  test("throws when frontmatter name does not match filename", async () => {
    const dir = makeDir({
      "actual.md": "---\nname: claimed\ndescription: ok\n---\nbody",
    });
    await expect(skills(dir)).rejects.toThrow(/must match the filename/);
  });

  /**
   * @case Unknown frontmatter fields are silently accepted and ignored
   * @preconditions File with Claude Code frontmatter fields the runtime does not consume
   *   (`allowed-tools`, `argument-hint`, `disable-model-invocation`, a nested `metadata` block,
   *   and an arbitrary unknown key)
   * @expectedResult Loads successfully; `name`, `description`, and `content` are populated
   *   from `name`, `description`, and the body; no other fields appear on the returned `Skill`
   */
  test("accepts and ignores unknown frontmatter keys", async () => {
    const dir = makeDir({
      "devoptix-hq.md": [
        "---",
        "name: devoptix-hq",
        "description: ok",
        "allowed-tools: Read Grep",
        "argument-hint: '[query]'",
        "disable-model-invocation: true",
        "metadata:",
        "  triggers: /devoptix-hq",
        "  command: devoptix-hq",
        "future-field: anything",
        "---",
        "body",
      ].join("\n"),
    });
    const result = await skills(dir);
    expect(result["devoptix-hq"]).toEqual({
      name: "devoptix-hq",
      description: "ok",
      content: "body",
    });
  });

  /**
   * @case Empty body rejected at load
   * @preconditions Skill markdown with frontmatter only
   * @expectedResult Throws RC5003 mentioning empty body
   */
  test("rejects empty skill body", async () => {
    const dir = makeDir({
      "x.md": "---\nname: x\ndescription: ok\n---\n",
    });
    await expect(skills(dir)).rejects.toThrow(/skill body is empty/);
  });

  /**
   * @case Per-skill description override
   * @preconditions Markdown loaded with override that replaces description
   * @expectedResult Result reflects override; original content preserved
   */
  test("applies per-skill overrides", async () => {
    const dir = makeDir({
      "x.md": "---\nname: x\ndescription: from-md\n---\nbody from md",
    });
    const result = await skills(dir, { x: { description: "overridden" } });
    expect(result["x"]?.description).toBe("overridden");
    expect(result["x"]?.content).toBe("body from md");
  });

  /**
   * @case Override referencing an unknown skill name fails loudly
   * @preconditions Override key not present in loaded files
   * @expectedResult Throws RC5003 with the offending key
   */
  test("override for an unknown skill throws", async () => {
    const dir = makeDir({
      "x.md": "---\nname: x\ndescription: ok\n---\nbody",
    });
    await expect(skills(dir, { y: { description: "nope" } })).rejects.toThrow(
      /override for "y" but no skill with that name/,
    );
  });

  /**
   * @case Nested `<name>/SKILL.md` layout (Claude Code convention)
   * @preconditions Subdirectory `devoptix-hq/` containing `SKILL.md`
   *   with frontmatter `name: devoptix-hq`
   * @expectedResult Skill is registered under the directory name with
   *   the body as content
   */
  test("loads nested <name>/SKILL.md layout", async () => {
    const dir = makeDir({
      "devoptix-hq/SKILL.md":
        "---\nname: devoptix-hq\ndescription: DevOptix HQ knowledge\n---\nKnow the org.",
    });
    const result = await skills(dir);
    expect(result).toEqual({
      "devoptix-hq": {
        name: "devoptix-hq",
        description: "DevOptix HQ knowledge",
        content: "Know the org.",
      },
    });
  });

  /**
   * @case Flat `.md` files and nested `<name>/SKILL.md` coexist
   * @preconditions One flat skill plus one nested skill in the same directory
   * @expectedResult Both skills load, keyed by file stem and directory
   *   name respectively
   */
  test("flat and nested layouts coexist in the same directory", async () => {
    const dir = makeDir({
      "cite-sources.md":
        "---\nname: cite-sources\ndescription: Cite\n---\nAlways cite.",
      "devoptix-hq/SKILL.md":
        "---\nname: devoptix-hq\ndescription: Org context\n---\nKnow the org.",
    });
    const result = await skills(dir);
    expect(Object.keys(result).sort()).toEqual(["cite-sources", "devoptix-hq"]);
    expect(result["cite-sources"]?.content).toBe("Always cite.");
    expect(result["devoptix-hq"]?.content).toBe("Know the org.");
  });

  /**
   * @case Subdirectory without a `SKILL.md` sentinel is silently skipped
   * @preconditions Directory `assets/` containing other files but no `SKILL.md`
   * @expectedResult Loader returns only the flat skill, no error thrown
   */
  test("subdirectories without SKILL.md are silently skipped", async () => {
    const dir = makeDir({
      "real-skill.md":
        "---\nname: real-skill\ndescription: real\n---\nreal body",
      "assets/notes.md":
        "---\nname: notes\ndescription: stray\n---\nstray body",
      "assets/template.txt": "not markdown",
    });
    const result = await skills(dir);
    expect(Object.keys(result)).toEqual(["real-skill"]);
  });

  /**
   * @case Nested layout: frontmatter name must match directory name
   * @preconditions `devoptix-hq/SKILL.md` declares `name: wrong`
   * @expectedResult Throws RC5003 mentioning the mismatch
   */
  test("nested layout: name mismatch with directory name throws", async () => {
    const dir = makeDir({
      "devoptix-hq/SKILL.md": "---\nname: wrong\ndescription: ok\n---\nbody",
    });
    await expect(skills(dir)).rejects.toThrow(/must match the filename/);
  });

  /**
   * @case Nested layout: empty body rejected
   * @preconditions `devoptix-hq/SKILL.md` with frontmatter only
   * @expectedResult Throws RC5003 mentioning empty body
   */
  test("nested layout: empty SKILL.md body throws", async () => {
    const dir = makeDir({
      "devoptix-hq/SKILL.md": "---\nname: devoptix-hq\ndescription: ok\n---\n",
    });
    await expect(skills(dir)).rejects.toThrow(/skill body is empty/);
  });

  /**
   * @case Nested layout coexists with bundled sibling files (Claude Code allows
   *   scripts/templates/examples alongside SKILL.md)
   * @preconditions `summarize/SKILL.md` plus a sibling `scripts/visualize.sh`
   * @expectedResult Only `SKILL.md` is consumed; sibling files are ignored,
   *   no error thrown
   */
  test("nested layout ignores bundled sibling files", async () => {
    const dir = makeDir({
      "summarize/SKILL.md":
        "---\nname: summarize\ndescription: Summarise\n---\nSummarise the diff.",
      "summarize/scripts/visualize.sh": "#!/usr/bin/env bash\necho hi",
      "summarize/examples/sample.md":
        "---\nname: sample\ndescription: stray\n---\nstray",
    });
    const result = await skills(dir);
    expect(Object.keys(result)).toEqual(["summarize"]);
    expect(result["summarize"]?.content).toBe("Summarise the diff.");
  });
});
