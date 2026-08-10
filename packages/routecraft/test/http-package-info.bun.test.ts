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
   * @case A workspace-container manifest (workspaces field) yields no identity
   * @preconditions The nearest package.json declares a `workspaces` array and
   *   carries a name and version of its own (the monorepo-root scenario)
   * @expectedResult Returns `{}`. A workspace container is repository
   *   infrastructure, not a service identity: it is typically private and
   *   its version drifts because release tooling never touches it, so its
   *   metadata must not surface on the publicly-served /openapi.json
   */
  test("workspace container with workspaces array yields no identity", () => {
    const dir = mktmp();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "@acme/workspace",
        version: "0.1.0",
        private: true,
        workspaces: ["packages/*"],
      }),
    );
    expect(findPackageInfo(dir)).toEqual({});
  });

  /**
   * @case A workspace container is skipped without falling through to a parent
   * @preconditions Inner directory holds a workspaces-declaring manifest; the
   *   parent directory holds a well-formed plain manifest
   * @expectedResult Returns `{}` rather than the parent's metadata. The walk
   *   commits to the nearest manifest level; an ancestor is even less related
   *   to the running service than the container itself
   */
  test("workspace container does not fall through to parent", () => {
    const root = mktmp();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "outer-app", version: "3.0.0" }),
    );
    const inner = join(root, "nested");
    mkdirSync(inner);
    writeFileSync(
      join(inner, "package.json"),
      JSON.stringify({ name: "inner-workspace", workspaces: [] }),
    );
    expect(findPackageInfo(inner)).toEqual({});
  });

  /**
   * @case A pnpm workspace root is recognised as a container
   * @preconditions The nearest package.json has no `workspaces` field but a
   *   `pnpm-workspace.yaml` sits beside it (pnpm keeps workspaces out of the
   *   manifest)
   * @expectedResult Returns `{}`, same as an npm / yarn / bun workspace root
   */
  test("pnpm-workspace.yaml beside the manifest marks a container", () => {
    const dir = mktmp();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "pnpm-root", version: "2.0.0", private: true }),
    );
    writeFileSync(
      join(dir, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n",
    );
    expect(findPackageInfo(dir)).toEqual({});
  });

  /**
   * @case private: true alone does not disqualify a manifest
   * @preconditions The nearest package.json is private with no workspaces
   *   field and no pnpm-workspace.yaml beside it (a deliberately-unpublished
   *   app)
   * @expectedResult Returns the manifest's name and version; an unpublished
   *   app's own identity is exactly what its /openapi.json should carry
   */
  test("private manifest without workspaces is still used", () => {
    const dir = mktmp();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "internal-app", version: "4.5.6", private: true }),
    );
    expect(findPackageInfo(dir)).toEqual({
      name: "internal-app",
      version: "4.5.6",
    });
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
