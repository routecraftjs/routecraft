import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { skillsBlock } from "../src/index.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rc-block-skills-"));
}

describe("skillsBlock() markdown loader", () => {
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
   * @case Loads multiple .md files in a directory as progressive blocks by default
   * @preconditions Two well-formed skill files; default mode (no override)
   * @expectedResult Returns one Block per file with mode "progressive" and body as the static value
   */
  test("loads a directory of skill markdown files as progressive blocks", async () => {
    const dir = makeDir({
      "web-search.md":
        "---\nname: web-search\ndescription: Search the web\n---\nUse a search engine first.",
      "cite-sources.md":
        "---\nname: cite-sources\ndescription: Cite your sources\n---\nAlways include citations.",
    });
    const result = await skillsBlock({ source: dir });
    expect(result.map((b) => b.name).sort()).toEqual([
      "cite-sources",
      "web-search",
    ]);
    const webSearch = result.find((b) => b.name === "web-search")!;
    expect(webSearch).toEqual({
      name: "web-search",
      description: "Search the web",
      mode: "progressive",
      value: "Use a search engine first.",
    });
  });

  /**
   * @case mode: "inject" preserves legacy "concatenate every skill verbatim" behaviour
   * @preconditions Single skill file with mode override
   * @expectedResult The resulting block has mode "inject"
   */
  test('mode: "inject" override produces inject-mode blocks', async () => {
    const dir = makeDir({
      "rules.md":
        "---\nname: rules\ndescription: The rules\n---\nRule one. Rule two.",
    });
    const result = await skillsBlock({ source: dir, mode: "inject" });
    expect(result[0]?.mode).toBe("inject");
  });

  /**
   * @case lifetime: "context" propagates to every loaded block
   * @preconditions Single skill file with lifetime override
   * @expectedResult Each block has lifetime: "context"
   */
  test('lifetime: "context" override propagates to every loaded block', async () => {
    const dir = makeDir({
      "x.md": "---\nname: x\ndescription: d\n---\nbody",
    });
    const result = await skillsBlock({ source: dir, lifetime: "context" });
    expect(result[0]?.lifetime).toBe("context");
  });

  /**
   * @case Single .md file path also works
   * @preconditions A single skill markdown file
   * @expectedResult Returns one block keyed by filename
   */
  test("loads a single .md file path", async () => {
    const dir = makeDir({
      "rules.md":
        "---\nname: rules\ndescription: The rules\n---\nRule one. Rule two.",
    });
    const result = await skillsBlock({ source: join(dir, "rules.md") });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "rules",
      description: "The rules",
      mode: "progressive",
      value: "Rule one. Rule two.",
    });
  });

  /**
   * @case Frontmatter name must match filename
   * @preconditions File "x.md" with frontmatter name "y"
   * @expectedResult Throws RC5027 mentioning the mismatch
   */
  test("throws when frontmatter name does not match filename", async () => {
    const dir = makeDir({
      "actual.md": "---\nname: claimed\ndescription: ok\n---\nbody",
    });
    await expect(skillsBlock({ source: dir })).rejects.toThrow(
      /must match the filename/,
    );
  });

  /**
   * @case Unknown frontmatter fields are silently accepted and ignored
   * @preconditions File with Claude Code frontmatter fields the runtime does not consume
   * @expectedResult Loads successfully; only name, description, and body materialise on the Block
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
    const result = await skillsBlock({ source: dir });
    expect(result[0]).toMatchObject({
      name: "devoptix-hq",
      description: "ok",
      value: "body",
    });
  });

  /**
   * @case Empty body rejected at load
   * @preconditions Skill markdown with frontmatter only
   * @expectedResult Throws RC5027 mentioning empty body
   */
  test("rejects empty skill body", async () => {
    const dir = makeDir({
      "x.md": "---\nname: x\ndescription: ok\n---\n",
    });
    await expect(skillsBlock({ source: dir })).rejects.toThrow(
      /skill body is empty/,
    );
  });

  /**
   * @case Nested `<name>/SKILL.md` layout (Claude Code convention)
   * @preconditions Subdirectory `devoptix-hq/` containing `SKILL.md`
   * @expectedResult Block is registered under the directory name
   */
  test("loads nested <name>/SKILL.md layout", async () => {
    const dir = makeDir({
      "devoptix-hq/SKILL.md":
        "---\nname: devoptix-hq\ndescription: DevOptix HQ knowledge\n---\nKnow the org.",
    });
    const result = await skillsBlock({ source: dir });
    expect(result).toEqual([
      {
        name: "devoptix-hq",
        description: "DevOptix HQ knowledge",
        mode: "progressive",
        value: "Know the org.",
      },
    ]);
  });

  /**
   * @case Flat `.md` files and nested `<name>/SKILL.md` coexist
   * @preconditions One flat skill plus one nested skill in the same directory
   * @expectedResult Both blocks load, keyed by file stem and directory name respectively
   */
  test("flat and nested layouts coexist in the same directory", async () => {
    const dir = makeDir({
      "cite-sources.md":
        "---\nname: cite-sources\ndescription: Cite\n---\nAlways cite.",
      "devoptix-hq/SKILL.md":
        "---\nname: devoptix-hq\ndescription: Org context\n---\nKnow the org.",
    });
    const result = await skillsBlock({ source: dir });
    expect(result.map((b) => b.name).sort()).toEqual([
      "cite-sources",
      "devoptix-hq",
    ]);
  });

  /**
   * @case Flat and nested skills resolving to the same name are rejected
   * @preconditions Both `foo.md` and `foo/SKILL.md` declare `name: foo`
   * @expectedResult Throws RC5026 mentioning the duplicate name
   */
  test("rejects duplicate skill names from flat and nested layouts", async () => {
    const dir = makeDir({
      "foo.md": "---\nname: foo\ndescription: flat\n---\nflat body",
      "foo/SKILL.md": "---\nname: foo\ndescription: nested\n---\nnested body",
    });
    await expect(skillsBlock({ source: dir })).rejects.toThrow(
      /duplicate skill name "foo"/,
    );
  });

  /**
   * @case skillsBlock validates its own options surface
   * @preconditions Missing/empty source string and invalid mode strings
   * @expectedResult Throws RC5027 with a clear authoring-time message
   */
  test("rejects misconfigured options", async () => {
    await expect(skillsBlock({ source: "" })).rejects.toThrow(
      /"source" must be a non-empty path/,
    );
    await expect(
      // @ts-expect-error -- intentionally pass an invalid mode
      skillsBlock({ source: "./irrelevant.md", mode: "bogus" }),
    ).rejects.toThrow(/"mode" must be "inject" or "progressive"/);
  });
});
