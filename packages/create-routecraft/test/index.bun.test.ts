import {
  describe,
  test,
  expect,
  mock,
  spyOn,
  beforeEach,
  afterEach,
} from "bun:test";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  collidingExamplePaths,
  generateProjectStructure,
  isExcludedExamplePath,
  mergeExamplePackageJson,
  parseGitHubExampleUrl,
  processTemplate,
  isUrl,
  type InitOptions,
} from "../src/lib.js";

// Suppress console output during tests
beforeEach(() => {
  spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
  spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  mock.restore();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeOptions(
  overrides: Partial<Required<InitOptions>> = {},
): Required<InitOptions> {
  return {
    projectName: "test-app",
    example: "none",
    packageManager: "bun",
    skipInstall: true,
    git: false,
    force: false,
    yes: true,
    ...overrides,
  };
}

async function readJson(filePath: string): Promise<any> {
  return JSON.parse(await readFile(filePath, "utf-8"));
}

// ─── Unit: processTemplate ───────────────────────────────────────────────────

describe("processTemplate", () => {
  /**
   * @case Replaces a single placeholder in the template string
   * @preconditions Template string contains one placeholder
   * @expectedResult Placeholder is replaced with the provided value
   */
  test("replaces a single placeholder", () => {
    const result = processTemplate("Hello, NAME!", { NAME: "World" });
    expect(result).toBe("Hello, World!");
  });

  /**
   * @case Replaces multiple different placeholders in one pass
   * @preconditions Template string contains two distinct placeholders
   * @expectedResult Both placeholders are replaced with their values
   */
  test("replaces multiple placeholders", () => {
    const result = processTemplate("A and B", { A: "1", B: "2" });
    expect(result).toBe("1 and 2");
  });

  /**
   * @case Replaces all occurrences of a repeated placeholder
   * @preconditions Template string contains the same placeholder twice
   * @expectedResult Both occurrences are replaced
   */
  test("replaces all occurrences of a repeated placeholder", () => {
    const result = processTemplate("X-X", { X: "Y" });
    expect(result).toBe("Y-Y");
  });

  /**
   * @case Returns the original string when no placeholders match
   * @preconditions Template string has no matching placeholders
   * @expectedResult String is returned unchanged
   */
  test("returns original string when no placeholders match", () => {
    const result = processTemplate("no match", { MISSING: "value" });
    expect(result).toBe("no match");
  });
});

// ─── Unit: isUrl ─────────────────────────────────────────────────────────────

describe("isUrl", () => {
  /**
   * @case Identifies HTTPS URLs
   * @preconditions Input starts with https://
   * @expectedResult Returns true
   */
  test("returns true for https URLs", () => {
    expect(isUrl("https://github.com/user/repo")).toBe(true);
  });

  /**
   * @case Identifies HTTP URLs
   * @preconditions Input starts with http://
   * @expectedResult Returns true
   */
  test("returns true for http URLs", () => {
    expect(isUrl("http://example.com")).toBe(true);
  });

  /**
   * @case Rejects plain strings
   * @preconditions Input is a plain string without protocol
   * @expectedResult Returns false
   */
  test("returns false for plain strings", () => {
    expect(isUrl("hello-world")).toBe(false);
    expect(isUrl("none")).toBe(false);
  });

  /**
   * @case Rejects empty string
   * @preconditions Input is empty
   * @expectedResult Returns false
   */
  test("returns false for empty string", () => {
    expect(isUrl("")).toBe(false);
  });
});

// ─── Scaffolding ─────────────────────────────────────────────────────────────

describe("generateProjectStructure", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = join(
      tmpdir(),
      `rc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  // ── Empty project ────────────────────────────────────────────────────────

  /**
   * @case Empty project creates correct directory structure
   * @preconditions No example selected
   * @expectedResult capabilities/, adapters/, plugins/ dirs exist at project root
   */
  test("empty project creates correct directory structure", async () => {
    await generateProjectStructure(projectDir, makeOptions());

    expect(existsSync(join(projectDir, "capabilities"))).toBe(true);
    expect(existsSync(join(projectDir, "adapters"))).toBe(true);
    expect(existsSync(join(projectDir, "plugins"))).toBe(true);
  });

  /**
   * @case Empty project index.ts has empty route export and craft config re-export
   * @preconditions No example selected
   * @expectedResult index.ts exports empty array and re-exports craftConfig from ./craft.config.js
   */
  test("empty project index.ts has empty route export and craft config re-export", async () => {
    await generateProjectStructure(projectDir, makeOptions());

    const content = await readFile(join(projectDir, "index.ts"), "utf-8");
    expect(content).toContain("export default [];");
    expect(content).toContain('from "./craft.config.js"');
    expect(content).not.toContain("hello-world");
  });

  /**
   * @case Empty project does not have a src/ directory
   * @preconditions No example selected
   * @expectedResult No src/ directory exists
   */
  test("empty project does not create a src directory", async () => {
    await generateProjectStructure(projectDir, makeOptions());

    expect(existsSync(join(projectDir, "src"))).toBe(false);
  });

  // ── Hello-world example ──────────────────────────────────────────────────

  /**
   * @case Hello-world example places the capability at capabilities/hello-world/route.ts
   * @preconditions example = "hello-world"
   * @expectedResult capabilities/hello-world/route.ts exists with route definition
   */
  test("hello-world example places capability file correctly", async () => {
    await generateProjectStructure(
      projectDir,
      makeOptions({ example: "hello-world" }),
    );

    const capPath = join(projectDir, "capabilities", "hello-world", "route.ts");
    expect(existsSync(capPath)).toBe(true);

    const content = await readFile(capPath, "utf-8");
    expect(content).toContain("hello-world");
  });

  /**
   * @case Hello-world example places the test alongside the capability route
   * @preconditions example = "hello-world"
   * @expectedResult capabilities/hello-world/route.bun.test.ts exists
   */
  test("hello-world example includes test file", async () => {
    await generateProjectStructure(
      projectDir,
      makeOptions({ example: "hello-world" }),
    );

    expect(
      existsSync(
        join(projectDir, "capabilities", "hello-world", "route.bun.test.ts"),
      ),
    ).toBe(true);
  });

  /**
   * @case Hello-world index.ts imports from ./capabilities/hello-world/route.js
   * @preconditions example = "hello-world"
   * @expectedResult index.ts contains correct relative import path
   */
  test("hello-world index.ts imports from ./capabilities/hello-world/route.js", async () => {
    await generateProjectStructure(
      projectDir,
      makeOptions({ example: "hello-world" }),
    );

    const content = await readFile(join(projectDir, "index.ts"), "utf-8");
    expect(content).toContain('from "./capabilities/hello-world/route.js"');
  });

  /**
   * @case Hello-world index.ts re-exports craftConfig from ./craft.config.js
   * @preconditions example = "hello-world"
   * @expectedResult index.ts contains craftConfig re-export
   */
  test("hello-world index.ts re-exports craftConfig", async () => {
    await generateProjectStructure(
      projectDir,
      makeOptions({ example: "hello-world" }),
    );

    const content = await readFile(join(projectDir, "index.ts"), "utf-8");
    expect(content).toContain('from "./craft.config.js"');
  });

  // ── package.json ─────────────────────────────────────────────────────────

  /**
   * @case package.json has correct name substitution
   * @preconditions projectName = "my-cool-app"
   * @expectedResult package.json name field is "my-cool-app"
   */
  test("package.json has correct name substitution", async () => {
    await generateProjectStructure(
      projectDir,
      makeOptions({ projectName: "my-cool-app" }),
    );

    const pkg = await readJson(join(projectDir, "package.json"));
    expect(pkg.name).toBe("my-cool-app");
  });

  /**
   * @case package.json start script points to index.ts at root with log level applied globally
   * @preconditions Default options
   * @expectedResult start script is "craft --log-level info run index.ts"
   */
  test("package.json start script points to root index.ts", async () => {
    await generateProjectStructure(projectDir, makeOptions());

    const pkg = await readJson(join(projectDir, "package.json"));
    const scripts = pkg.scripts;
    expect(scripts.start).toBe("craft --log-level info run index.ts");
  });

  /**
   * @case package.json does not have a build script
   * @preconditions Default options
   * @expectedResult No build script in package.json scripts
   */
  test("package.json does not have a build script", async () => {
    await generateProjectStructure(projectDir, makeOptions());

    const pkg = await readJson(join(projectDir, "package.json"));
    const scripts = pkg.scripts;
    expect(scripts.build).toBeUndefined();
  });

  /**
   * @case package.json has correct package manager substitution
   * @preconditions packageManager = "pnpm"
   * @expectedResult packageManager field contains "pnpm@"
   */
  test("package.json has correct package manager substitution", async () => {
    await generateProjectStructure(
      projectDir,
      makeOptions({ packageManager: "pnpm" }),
    );

    const pkg = await readJson(join(projectDir, "package.json"));
    expect(pkg.packageManager).toMatch(/^pnpm@/);
  });

  /**
   * @case package.json substitutes routecraft version in dependencies
   * @preconditions Default options
   * @expectedResult Dependencies contain routecraft version (not the placeholder)
   */
  test("package.json replaces version placeholders", async () => {
    await generateProjectStructure(projectDir, makeOptions());

    const pkg = await readJson(join(projectDir, "package.json"));
    const deps = pkg.dependencies;
    const devDeps = pkg.devDependencies;

    expect(deps["@routecraft/routecraft"]).not.toBe("ROUTECRAFT_VERSION");
    expect(devDeps["@routecraft/cli"]).not.toBe("ROUTECRAFT_VERSION");
    expect(devDeps["@routecraft/testing"]).not.toBe("ROUTECRAFT_VERSION");
  });

  /**
   * @case package.json works with all four package managers
   * @preconditions Each package manager variant
   * @expectedResult Each produces a valid packageManager field
   */
  test.each(["npm", "pnpm", "yarn", "bun"] as const)(
    "package.json sets correct packageManager for %s",
    async (pm) => {
      const dir = join(projectDir, pm);
      await mkdir(dir, { recursive: true });
      await generateProjectStructure(dir, makeOptions({ packageManager: pm }));

      const pkg = await readJson(join(dir, "package.json"));
      expect(pkg.packageManager).toMatch(new RegExp(`^${pm}@`));
    },
  );

  // ── Config files ─────────────────────────────────────────────────────────

  /**
   * @case All expected config files are present at project root
   * @preconditions Default options
   * @expectedResult .gitignore, .prettierrc, craft.config.ts, eslint.config.mjs, tsconfig.json exist (vitest.config.ts not present; template uses bun:test)
   */
  test("all config files are present at project root", async () => {
    await generateProjectStructure(projectDir, makeOptions());

    const expectedFiles = [
      ".gitignore",
      ".prettierrc",
      "craft.config.ts",
      "eslint.config.mjs",
      "tsconfig.json",
      "package.json",
      "index.ts",
    ];

    for (const file of expectedFiles) {
      expect(existsSync(join(projectDir, file))).toBe(true);
    }
  });

  /**
   * @case tsconfig.json does not have an outDir (no build step)
   * @preconditions Default options
   * @expectedResult tsconfig.json compilerOptions has no outDir
   */
  test("tsconfig.json does not have outDir", async () => {
    await generateProjectStructure(projectDir, makeOptions());

    const tsconfig = await readJson(join(projectDir, "tsconfig.json"));
    expect(tsconfig.compilerOptions.outDir).toBeUndefined();
  });

  // ── Per-example deps ─────────────────────────────────────────────────────

  /**
   * @case Hello-world example adds zod to package.json dependencies
   * @preconditions example = "hello-world"
   * @expectedResult package.json.dependencies contains zod
   */
  test("hello-world example merges its deps.json into package.json", async () => {
    await generateProjectStructure(
      projectDir,
      makeOptions({ example: "hello-world" }),
    );

    const pkg = await readJson(join(projectDir, "package.json"));
    expect(pkg.dependencies).toHaveProperty("zod");
  });

  /**
   * @case Per-example deps.json is not copied into the scaffolded project
   * @preconditions example = "hello-world"
   * @expectedResult deps.json is absent from the project root
   */
  test("hello-world example does not copy deps.json into project", async () => {
    await generateProjectStructure(
      projectDir,
      makeOptions({ example: "hello-world" }),
    );

    expect(existsSync(join(projectDir, "deps.json"))).toBe(false);
  });

  /**
   * @case Empty project does not gain example-only deps
   * @preconditions example = "none"
   * @expectedResult package.json.dependencies does not contain zod
   */
  test("empty project does not include example-only deps", async () => {
    await generateProjectStructure(projectDir, makeOptions());

    const pkg = await readJson(join(projectDir, "package.json"));
    expect(pkg.dependencies).not.toHaveProperty("zod");
  });

  // ── Unknown example ──────────────────────────────────────────────────────

  /**
   * @case Unknown built-in example throws an error
   * @preconditions example = "does-not-exist"
   * @expectedResult Error thrown with "Unknown example" message
   */
  test("unknown built-in example throws an error", async () => {
    await expect(
      generateProjectStructure(
        projectDir,
        makeOptions({ example: "does-not-exist" }),
      ),
    ).rejects.toThrow("Unknown example: does-not-exist");
  });
});

// ─── Unit: example copy filters ──────────────────────────────────────────────

describe("isExcludedExamplePath", () => {
  /**
   * @case The repository directory and installed packages are excluded
   * @preconditions Paths inside .git/ and node_modules/ at any depth
   * @expectedResult Both excluded, at the root and nested
   */
  test("excludes .git and node_modules at any depth", () => {
    expect(isExcludedExamplePath(".git/HEAD")).toBe(true);
    expect(isExcludedExamplePath("node_modules/zod/index.js")).toBe(true);
    expect(isExcludedExamplePath("packages/app/node_modules/x.js")).toBe(true);
  });

  /**
   * @case Files whose names merely start with .git are kept
   * @preconditions .gitignore and .github/workflows/ci.yml
   * @expectedResult Both kept, because a substring test used to drop a template's
   *   gitignore and its whole CI folder along with the repository directory
   */
  test("keeps .gitignore and .github", () => {
    expect(isExcludedExamplePath(".gitignore")).toBe(false);
    expect(isExcludedExamplePath(".github/workflows/ci.yml")).toBe(false);
  });

  /**
   * @case Every lockfile is excluded, bun's included
   * @preconditions One path per supported package manager
   * @expectedResult All excluded, so a scaffolded project resolves its own tree
   */
  test("excludes every lockfile", () => {
    for (const file of [
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "bun.lock",
      "bun.lockb",
    ]) {
      expect(isExcludedExamplePath(file)).toBe(true);
    }
  });

  /**
   * @case A path that merely contains a lockfile name is kept
   * @preconditions A capability folder named after a lockfile parser
   * @expectedResult Kept, because the exclusion matches whole segments
   */
  test("keeps a path that only contains a lockfile name", () => {
    expect(
      isExcludedExamplePath("capabilities/pnpm-lock.yaml-parser/route.ts"),
    ).toBe(false);
  });

  /**
   * @case The example root is never excluded
   * @preconditions The empty relative path node:fs/promises cp passes for the root
   * @expectedResult Kept, or the copy would produce nothing at all
   */
  test("keeps the example root", () => {
    expect(isExcludedExamplePath("")).toBe(false);
  });
});

describe("collidingExamplePaths", () => {
  let source: string;
  let target: string;

  beforeEach(async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    source = join(tmpdir(), `rc-src-${stamp}`);
    target = join(tmpdir(), `rc-dst-${stamp}`);
    await mkdir(join(source, "capabilities", "greet"), { recursive: true });
    await mkdir(join(target, "capabilities", "greet"), { recursive: true });
  });

  afterEach(async () => {
    await rm(source, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  });

  /**
   * @case Files the target already holds are reported, nested ones included
   * @preconditions An example and a project that share index.ts and a nested route.ts
   * @expectedResult Both reported by their example-relative path, sorted, so the
   *   copy can name what it dropped instead of losing it silently
   */
  test("reports files the project already has", async () => {
    await writeFile(join(source, "index.ts"), "example");
    await writeFile(join(target, "index.ts"), "base");
    await writeFile(join(source, "capabilities", "greet", "route.ts"), "a");
    await writeFile(join(target, "capabilities", "greet", "route.ts"), "b");
    await writeFile(join(source, "README.md"), "only in the example");

    expect(await collidingExamplePaths(source, target)).toEqual([
      join("capabilities", "greet", "route.ts"),
      "index.ts",
    ]);
  });

  /**
   * @case Excluded paths are never reported
   * @preconditions A lockfile present on both sides
   * @expectedResult Not reported, because the copy skips it deliberately rather
   *   than dropping it by collision
   */
  test("never reports a path the copy skips anyway", async () => {
    await writeFile(join(source, "bun.lock"), "x");
    await writeFile(join(target, "bun.lock"), "y");

    expect(await collidingExamplePaths(source, target)).toEqual([]);
  });
});

describe("mergeExamplePackageJson", () => {
  let source: string;
  let target: string;

  beforeEach(async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    source = join(tmpdir(), `rc-src-${stamp}`);
    target = join(tmpdir(), `rc-dst-${stamp}`);
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(
      join(target, "package.json"),
      JSON.stringify({
        name: "my-app",
        packageManager: "bun@1.3.9",
        scripts: { start: "craft run index.ts", lint: "eslint ." },
        dependencies: { "@routecraft/routecraft": "^0.6.0" },
        devDependencies: { typescript: "^5.9.3" },
      }),
    );
  });

  afterEach(async () => {
    await rm(source, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  });

  /**
   * @case The project name and package manager survive a template package.json
   * @preconditions A URL example declaring its own name and packageManager
   * @expectedResult Both keep the scaffold's values, because they are what the
   *   user typed and picked rather than anything the template can know
   */
  test("keeps the project name and package manager", async () => {
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({ name: "craft-harness", packageManager: "npm@10.0.0" }),
    );

    await mergeExamplePackageJson(source, target);

    const pkg = await readJson(join(target, "package.json"));
    expect(pkg.name).toBe("my-app");
    expect(pkg.packageManager).toBe("bun@1.3.9");
  });

  /**
   * @case A manifest map field that is not a map is refused
   * @preconditions A template whose "scripts" is a string rather than an object
   * @expectedResult Throws naming the field, rather than spreading it into indexed properties and writing a package.json no package manager can read
   */
  test("refuses a manifest field that is not a map", async () => {
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({ scripts: "craft start" }),
    );

    await expect(mergeExamplePackageJson(source, target)).rejects.toThrow(
      /"scripts"/,
    );
  });

  /**
   * @case An array in a manifest map field is refused
   * @preconditions A template declaring dependencies as an array
   * @expectedResult Throws, because an array spreads to numeric keys just as a string does
   */
  test("refuses an array in a manifest map field", async () => {
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({ dependencies: ["zod"] }),
    );

    await expect(mergeExamplePackageJson(source, target)).rejects.toThrow(
      /an array/,
    );
  });

  /**
   * @case Dependency maps and scripts merge key by key
   * @preconditions A template declaring one extra dependency and one extra script
   * @expectedResult The base entries survive alongside the template's, and the
   *   template wins where both declare the same key
   */
  test("merges dependency maps and scripts instead of replacing them", async () => {
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({
        scripts: { start: "craft start", test: "bun test" },
        dependencies: { "@routecraft/ai": "^0.6.0" },
        devDependencies: { prettier: "^3.8.1" },
      }),
    );

    await mergeExamplePackageJson(source, target);

    const pkg = await readJson(join(target, "package.json"));
    expect(pkg.scripts).toEqual({
      start: "craft start",
      lint: "eslint .",
      test: "bun test",
    });
    expect(pkg.dependencies).toEqual({
      "@routecraft/routecraft": "^0.6.0",
      "@routecraft/ai": "^0.6.0",
    });
    expect(pkg.devDependencies).toEqual({
      typescript: "^5.9.3",
      prettier: "^3.8.1",
    });
  });

  /**
   * @case An example with no package.json leaves the scaffold alone
   * @preconditions An example fragment carrying only route files
   * @expectedResult The base manifest is unchanged, since it already describes the project
   */
  test("leaves the manifest alone when the example has none", async () => {
    const before = await readJson(join(target, "package.json"));
    await mergeExamplePackageJson(source, target);
    expect(await readJson(join(target, "package.json"))).toEqual(before);
  });
});

// ─── Unit: parseGitHubExampleUrl ─────────────────────────────────────────────

describe("parseGitHubExampleUrl", () => {
  /**
   * @case A plain repository URL takes the default branch and the whole tree
   * @preconditions No /tree/ segment
   * @expectedResult branch "main" and an empty subpath, because templates are
   *   untagged and always scaffolded from main
   */
  test("defaults to main and the repository root", () => {
    expect(parseGitHubExampleUrl("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
      branch: "main",
      subPath: "",
    });
  });

  /**
   * @case A branch with no subpath names the whole repository at that branch
   * @preconditions /tree/<branch> with and without a trailing slash
   * @expectedResult The branch, and an empty subpath. Without this a template
   *   repository cannot scaffold from the branch under test in its own CI.
   */
  test("accepts a branch with no subpath", () => {
    for (const url of [
      "https://github.com/owner/repo/tree/feature-x",
      "https://github.com/owner/repo/tree/feature-x/",
    ]) {
      expect(parseGitHubExampleUrl(url)).toEqual({
        owner: "owner",
        repo: "repo",
        branch: "feature-x",
        subPath: "",
      });
    }
  });

  /**
   * @case A branch and a subpath are both read
   * @preconditions /tree/<branch>/<nested/path>
   * @expectedResult Both, with the subpath keeping its own separators
   */
  test("reads a branch and a nested subpath", () => {
    expect(
      parseGitHubExampleUrl(
        "https://github.com/owner/repo/tree/main/examples/api",
      ),
    ).toEqual({
      owner: "owner",
      repo: "repo",
      branch: "main",
      subPath: "examples/api",
    });
  });

  /**
   * @case A .git suffix is tolerated
   * @preconditions A clone URL pasted as an example
   * @expectedResult The repository name without the suffix
   */
  test("strips a .git suffix", () => {
    expect(parseGitHubExampleUrl("https://github.com/owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
      branch: "main",
      subPath: "",
    });
  });

  /**
   * @case A URL that is not a GitHub repository is refused
   * @preconditions A host that is not github.com, and a path with no repo
   * @expectedResult Throws, rather than cloning something unexpected
   */
  test("refuses a URL that is not a GitHub repository", () => {
    expect(() =>
      parseGitHubExampleUrl("https://example.com/owner/repo"),
    ).toThrow();
    expect(() => parseGitHubExampleUrl("https://github.com/owner")).toThrow();
  });

  /**
   * @case A backslash-separated climb is refused too
   * @preconditions A subpath using Windows separators, which a "/"-only split would miss
   * @expectedResult Throws, because join() on Windows treats both separators alike
   */
  test("refuses a subpath that escapes using backslashes", () => {
    expect(() =>
      parseGitHubExampleUrl(
        "https://github.com/owner/repo/tree/main/..\\..\\outside",
      ),
    ).toThrow(/cannot contain/);
  });

  /**
   * @case A query string or fragment is not part of the path
   * @preconditions A URL copied from the GitHub file view, carrying ?plain=1 and an anchor
   * @expectedResult The subpath is the path alone, so the clone finds it
   */
  test("ignores a query string and a fragment", () => {
    expect(
      parseGitHubExampleUrl(
        "https://github.com/owner/repo/tree/main/examples/app?plain=1#L20",
      ),
    ).toMatchObject({ branch: "main", subPath: "examples/app" });
  });

  /**
   * @case A subpath that climbs out of the repository is refused
   * @preconditions A /tree/ URL whose path contains a ".." segment
   * @expectedResult Throws, so nothing outside the clone is ever copied into
   *   the new project
   */
  test("refuses a subpath that escapes the repository", () => {
    expect(() =>
      parseGitHubExampleUrl(
        "https://github.com/owner/repo/tree/main/../../../etc",
      ),
    ).toThrow(/cannot contain/);
    expect(() =>
      parseGitHubExampleUrl(
        "https://github.com/owner/repo/tree/main/a/../../b",
      ),
    ).toThrow(/cannot contain/);
  });

  /**
   * @case A path that merely contains two dots is kept
   * @preconditions A subpath whose segments contain dots but are not ".."
   * @expectedResult Parses, because the guard is per segment
   */
  test("keeps a subpath whose segments merely contain dots", () => {
    expect(
      parseGitHubExampleUrl("https://github.com/owner/repo/tree/main/v1..2/x"),
    ).toMatchObject({ subPath: "v1..2/x" });
  });
});
