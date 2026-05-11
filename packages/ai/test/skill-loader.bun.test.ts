import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
      writeFileSync(join(dir, name), content, "utf-8");
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
   * @case Unsupported frontmatter field rejected with a clear message
   * @preconditions File with `version: 1` in frontmatter
   * @expectedResult Throws RC5003 listing the unsupported field
   */
  test("rejects unsupported frontmatter fields", async () => {
    const dir = makeDir({
      "x.md": "---\nname: x\ndescription: ok\nversion: 1\n---\nbody",
    });
    await expect(skills(dir)).rejects.toThrow(
      /unsupported frontmatter field "version"/,
    );
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
});
