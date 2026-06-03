import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findPackageInfo } from "../src/plugins/http/package-info";

describe("findPackageInfo", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    while (cleanup.length > 0) {
      const dir = cleanup.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function mktmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "rc-pkginfo-"));
    cleanup.push(dir);
    return dir;
  }

  /**
   * @case findPackageInfo reads name and version from the nearest package.json
   * @preconditions A well-formed package.json sits at the start directory
   * @expectedResult Returns { name, version } with the parsed string values
   */
  test("returns name and version from a valid package.json", () => {
    const dir = mktmp();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "example-app", version: "1.2.3" }),
    );
    expect(findPackageInfo(dir)).toEqual({
      name: "example-app",
      version: "1.2.3",
    });
  });

  /**
   * @case findPackageInfo walks upward to find a package.json above start
   * @preconditions package.json sits one directory above the start path
   * @expectedResult Returns the parent's name + version
   */
  test("walks upward to the nearest package.json", () => {
    const root = mktmp();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "outer", version: "9.9.9" }),
    );
    const inner = join(root, "src");
    mkdirSync(inner);
    expect(findPackageInfo(inner)).toEqual({
      name: "outer",
      version: "9.9.9",
    });
  });

  /**
   * @case A malformed local package.json does NOT fall through to a parent
   * @preconditions Inner directory contains an unparseable package.json; the
   *   parent directory contains a well-formed one with totally different
   *   metadata (the monorepo-root scenario).
   * @expectedResult Returns `{}` rather than the parent's metadata. A
   *   corrupt local manifest must not silently get replaced with an
   *   unrelated parent's name + version, since that would leak through
   *   the publicly-served /openapi.json doc.
   */
  test("malformed local package.json does not fall through to parent", () => {
    const root = mktmp();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "monorepo-root", version: "0.0.1" }),
    );
    const inner = join(root, "apps", "broken");
    mkdirSync(join(root, "apps"));
    mkdirSync(inner);
    writeFileSync(join(inner, "package.json"), "{ this is not valid json");

    expect(findPackageInfo(inner)).toEqual({});
  });

  /**
   * @case findPackageInfo returns {} when no package.json exists above start
   * @preconditions Start directory and every ancestor lack a package.json
   *   (simulated by starting from a freshly created tmpdir whose path
   *   contains no package.json all the way to the filesystem root)
   * @expectedResult Returns `{}` after the bounded walk gives up
   */
  test("returns empty when no package.json is reachable", () => {
    const dir = mktmp();
    const inner = join(dir, "deep", "deeper");
    mkdirSync(join(dir, "deep"));
    mkdirSync(inner);
    expect(findPackageInfo(inner)).toEqual({});
  });

  /**
   * @case findPackageInfo ignores non-string name and version fields
   * @preconditions package.json has numeric `version` and object `name`
   * @expectedResult Both fields are dropped; the result is `{}`
   */
  test("ignores non-string name and version", () => {
    const dir = mktmp();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: { not: "a string" }, version: 42 }),
    );
    expect(findPackageInfo(dir)).toEqual({});
  });
});
