import {
  describe,
  test,
  expect,
  mock,
  spyOn,
  beforeEach,
  afterEach,
} from "bun:test";
import {
  mkdir,
  mkdtemp,
  rm,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  assertInsideRepository,
  isSymbolicLink,
  generateProjectStructure,
  isExcludedExamplePath,
  mergeExamplePackageJson,
  getRoutecraftVersion,
  parseGitHubExampleUrl,
  resolveExampleRef,
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
    example: "",
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
   * @case A placeholder that is a prefix of another does not consume it
   * @preconditions Two placeholders where one name is a prefix of the other, declared shortest first so object key order would get it wrong
   * @expectedResult Both resolve fully. The failure this guards is silent: the shorter key leaves "bun@1.3.9_RUN" in the output, which throws nowhere and is only ever noticed by a reader
   */
  test("replaces the longer placeholder when one is a prefix of another", () => {
    const result = processTemplate("PM and PM_RUN start", {
      PM: "bun@1.3.9",
      PM_RUN: "bun run",
    });
    expect(result).toBe("bun@1.3.9 and bun run start");
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

  // ── Layout ───────────────────────────────────────────────────────────────

  /**
   * @case The scaffold is laid out for the folder convention
   * @preconditions Default options
   * @expectedResult capabilities/hello-world carries the route, its test and its README, and there is no src/
   */
  test("places the sample capability under capabilities/", async () => {
    await generateProjectStructure(projectDir, makeOptions());

    const capability = join(projectDir, "capabilities", "hello-world");
    expect(existsSync(join(capability, "route.ts"))).toBe(true);
    expect(existsSync(join(capability, "route.bun.test.ts"))).toBe(true);
    expect(existsSync(join(capability, "README.md"))).toBe(true);
    expect(existsSync(join(projectDir, "src"))).toBe(false);
  });

  /**
   * @case No entry file is written
   * @preconditions Default options
   * @expectedResult index.ts is absent. `craft start` discovers capabilities from disk, so a file re-exporting them is one the author maintains for nothing
   */
  test("writes no index.ts", async () => {
    await generateProjectStructure(projectDir, makeOptions());

    expect(existsSync(join(projectDir, "index.ts"))).toBe(false);
  });

  /**
   * @case Empty convention directories are not created
   * @preconditions Default options
   * @expectedResult adapters/ and plugins/ are absent. Git cannot carry an empty directory, so scaffolding them produced folders that vanished on the author's first commit
   */
  test("does not create empty convention directories", async () => {
    await generateProjectStructure(projectDir, makeOptions());

    expect(existsSync(join(projectDir, "adapters"))).toBe(false);
    expect(existsSync(join(projectDir, "plugins"))).toBe(false);
  });

  // ── README ───────────────────────────────────────────────────────────────

  /**
   * @case The project README resolves its placeholders
   * @preconditions projectName = "my-cool-app", packageManager = "pnpm"
   * @expectedResult The README names the project and the package manager the caller chose, with no placeholder left behind
   */
  test("README names the project and the chosen package manager", async () => {
    await generateProjectStructure(
      projectDir,
      makeOptions({ projectName: "my-cool-app", packageManager: "pnpm" }),
    );

    const readme = await readFile(join(projectDir, "README.md"), "utf-8");
    expect(readme).toContain("# my-cool-app");
    expect(readme).toContain("pnpm run start");
    expect(readme).not.toContain("PROJECT_NAME");
    expect(readme).not.toContain("PACKAGE_MANAGER_RUN");
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
   * @case package.json boots through the folder convention
   * @preconditions Default options
   * @expectedResult start script is "craft start". The scaffolder prints this command as the first thing to run, so it must not name a file the layout no longer has
   */
  test("package.json start script is craft start", async () => {
    await generateProjectStructure(projectDir, makeOptions());

    const pkg = await readJson(join(projectDir, "package.json"));
    expect(pkg.scripts.start).toBe("craft start");
  });

  /**
   * @case package.json does not have a build script
   * @preconditions Default options
   * @expectedResult No build script in package.json scripts
   */
  test("package.json does not have a build script", async () => {
    await generateProjectStructure(projectDir, makeOptions());

    const pkg = await readJson(join(projectDir, "package.json"));
    expect(pkg.scripts.build).toBeUndefined();
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

    expect(pkg.dependencies["@routecraft/routecraft"]).not.toBe(
      "ROUTECRAFT_VERSION",
    );
    expect(pkg.devDependencies["@routecraft/cli"]).not.toBe(
      "ROUTECRAFT_VERSION",
    );
    expect(pkg.devDependencies["@routecraft/testing"]).not.toBe(
      "ROUTECRAFT_VERSION",
    );
  });

  /**
   * @case The sample capability's dependency ships in the manifest
   * @preconditions Default options
   * @expectedResult zod is a dependency. The capability imports it, so a scaffold without it does not type-check, which is what the per-example deps.json used to carry
   */
  test("package.json carries the sample capability's dependency", async () => {
    await generateProjectStructure(projectDir, makeOptions());

    const pkg = await readJson(join(projectDir, "package.json"));
    expect(pkg.dependencies).toHaveProperty("zod");
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
   * @expectedResult .gitignore, .prettierrc, craft.config.ts, eslint.config.mjs, tsconfig.json, package.json and README.md exist (no vitest.config.ts; the template uses bun:test)
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
      "README.md",
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

  // ── URL examples ─────────────────────────────────────────────────────────

  /**
   * @case A URL example does not inherit the sample capability or the README
   * @preconditions example is a URL that cannot be cloned, so the run fails after the base files are written
   * @expectedResult capabilities/ and README.md are absent while package.json is present. A URL example is a whole project, and hello-world left standing inside somebody else's harness is a route their CI never saw
   */
  test("a URL example is not given the sample capability", async () => {
    await generateProjectStructure(projectDir, {
      ...makeOptions(),
      example: "https://github.com/routecraftjs/does-not-exist-ever",
    }).catch(() => undefined);

    expect(existsSync(join(projectDir, "capabilities"))).toBe(false);
    expect(existsSync(join(projectDir, "README.md"))).toBe(false);
    expect(existsSync(join(projectDir, "package.json"))).toBe(true);
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
   * @preconditions .gitignore and a .github file outside workflows/
   * @expectedResult Both kept, because a substring test used to drop a template's
   *   gitignore and its whole .github folder along with the repository directory
   */
  test("keeps .gitignore and .github", () => {
    expect(isExcludedExamplePath(".gitignore")).toBe(false);
    expect(isExcludedExamplePath(".github/CODEOWNERS")).toBe(false);
    expect(isExcludedExamplePath(".github/ISSUE_TEMPLATE/bug.md")).toBe(false);
  });

  /**
   * @case The template's CI is not copied into the scaffolded project
   * @preconditions A workflow file under .github/workflows/
   * @expectedResult Excluded. The template's CI is about the template's repository, tested against its branches and its secrets, so it either fails on the new project's first push or is guarded into never running and sits there as config nobody wrote
   */
  test("excludes the example's workflows", () => {
    expect(isExcludedExamplePath(".github/workflows/ci.yml")).toBe(true);
    expect(isExcludedExamplePath(".github/workflows/nested/deploy.yml")).toBe(
      true,
    );
  });

  /**
   * @case A capability folder called workflows/ survives
   * @preconditions A path whose segment is "workflows" but which is not under .github/
   * @expectedResult Kept. This is why the exclusion is a path prefix rather than a segment name: the thing being excluded is a location, not a word
   */
  test("keeps a capability folder named workflows", () => {
    expect(isExcludedExamplePath("capabilities/workflows/route.ts")).toBe(
      false,
    );
    expect(isExcludedExamplePath("workflows/route.ts")).toBe(false);
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
   * @case An example's routecraft pins are replaced by the scaffolder's own
   * @preconditions An example pinning three @routecraft/* packages, two of them at versions the scaffolder did not choose and one it does not itself declare
   * @expectedResult Every @routecraft/* entry carries the scaffolder's version. Asking for @canary and being handed whatever the example last committed is the defect, and a mixed train across a lockstep-versioned group is the symptom: @routecraft/os sat eight days behind the rest
   */
  test("replaces an example's routecraft pins with the scaffolder's", async () => {
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({
        dependencies: {
          "@routecraft/routecraft": "0.7.0-canary-20260907165225",
          "@routecraft/os": "0.7.0-canary-20260830203136",
          zod: "^4.3.6",
        },
        devDependencies: { "@routecraft/cli": "0.7.0-canary-20260907165225" },
      }),
    );

    await mergeExamplePackageJson(source, target);

    const pkg = await readJson(join(target, "package.json"));
    const scaffolderVersion = getRoutecraftVersion();

    expect(pkg.dependencies["@routecraft/routecraft"]).toBe(scaffolderVersion);
    expect(pkg.dependencies["@routecraft/os"]).toBe(scaffolderVersion);
    expect(pkg.devDependencies["@routecraft/cli"]).toBe(scaffolderVersion);
    // The example's own choices are its own. Only the framework train is
    // taken out of its hands.
    expect(pkg.dependencies["zod"]).toBe("^4.3.6");
  });

  /**
   * @case An example's scripts are not treated as versions
   * @preconditions An example declaring a script whose name would be meaningless to pin
   * @expectedResult Scripts merge untouched, because the pinning walks dependency maps and scripts is not one
   */
  test("leaves an example's scripts alone", async () => {
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({
        scripts: { start: "craft start", boot: "craft start --once" },
      }),
    );

    await mergeExamplePackageJson(source, target);

    const pkg = await readJson(join(target, "package.json"));
    expect(pkg.scripts.start).toBe("craft start");
    expect(pkg.scripts.boot).toBe("craft start --once");
    expect(pkg.scripts.lint).toBe("eslint .");
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
   * @case A symlinked manifest is not read
   * @preconditions The example's package.json is a link pointing outside the clone
   * @expectedResult The merge leaves the scaffold alone rather than reading through the link
   */
  test("ignores a package.json that is a symlink", async () => {
    // The sentinel lives under `source` so afterEach removes it even when an
    // assertion fails, and it carries a script rather than a name: `name` is
    // project-owned and restored from the scaffold either way, so asserting
    // on it would pass whether or not the link was read.
    const outside = join(source, "linked-manifest.json");
    await writeFile(
      outside,
      JSON.stringify({ scripts: { leaked: "echo through-the-link" } }),
    );
    await symlink(outside, join(source, "package.json"));

    await mergeExamplePackageJson(source, target);

    const pkg = await readJson(join(target, "package.json"));
    expect(pkg.scripts?.leaked).toBeUndefined();
  });

  /**
   * @case A non-string value inside a manifest map is refused
   * @preconditions A template whose scripts map carries a number
   * @expectedResult Throws naming the offending entry, rather than writing a numeric value into the generated package.json
   */
  test("refuses a non-string value inside a manifest map", async () => {
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({ scripts: { start: 1 } }),
    );

    await expect(mergeExamplePackageJson(source, target)).rejects.toThrow(
      /"scripts\.start"/,
    );
  });

  /**
   * @case A null value inside a manifest map is refused
   * @preconditions A template whose dependencies map carries null
   * @expectedResult Throws, because null survives the spread as readily as a number
   */
  test("refuses a null value inside a manifest map", async () => {
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({ dependencies: { zod: null } }),
    );

    await expect(mergeExamplePackageJson(source, target)).rejects.toThrow(
      /null/,
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
   * @case A plain repository URL names no ref and no path
   * @preconditions No /tree/ segment
   * @expectedResult An empty remainder, which resolves to the repository's default branch. The parser no longer assumes "main": a repository whose default is `master` or `trunk` was previously cloned at a branch that may not exist
   */
  test("reads a plain repository URL", () => {
    expect(parseGitHubExampleUrl("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
      remainder: "",
    });
  });

  /**
   * @case The remainder is kept unsplit
   * @preconditions /tree/<something> with and without a trailing slash
   * @expectedResult The whole remainder, because a ref name may contain "/" and only the remote can say where it ends
   */
  test("keeps the remainder unsplit", () => {
    for (const url of [
      "https://github.com/owner/repo/tree/feature-x",
      "https://github.com/owner/repo/tree/feature-x/",
    ]) {
      expect(parseGitHubExampleUrl(url)).toEqual({
        owner: "owner",
        repo: "repo",
        remainder: "feature-x",
      });
    }
  });

  /**
   * @case A multi-segment remainder is not split by the parser
   * @preconditions /tree/<ref>/<path>, where the boundary is unknowable from the URL
   * @expectedResult The remainder whole. This is the defect: `claude/my-branch` used to parse as branch `claude` with `my-branch` as a path inside it, which no clone could satisfy
   */
  test("does not guess where a multi-segment remainder divides", () => {
    expect(
      parseGitHubExampleUrl(
        "https://github.com/owner/repo/tree/main/examples/api",
      ),
    ).toEqual({
      owner: "owner",
      repo: "repo",
      remainder: "main/examples/api",
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
      remainder: "",
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
   * @preconditions A remainder using Windows separators, which a "/"-only split would miss
   * @expectedResult Throws, because join() on Windows treats both separators alike
   */
  test("refuses a remainder that escapes using backslashes", () => {
    expect(() =>
      parseGitHubExampleUrl(
        "https://github.com/owner/repo/tree/main/..\\..\\outside",
      ),
    ).toThrow(/cannot contain/);
  });

  /**
   * @case A query string or fragment is not part of the path
   * @preconditions A URL copied from the GitHub file view, carrying ?plain=1 and an anchor
   * @expectedResult The remainder is the path alone, so the clone finds it
   */
  test("ignores a query string and a fragment", () => {
    expect(
      parseGitHubExampleUrl(
        "https://github.com/owner/repo/tree/main/examples/app?plain=1#L20",
      ),
    ).toMatchObject({ remainder: "main/examples/app" });
  });

  /**
   * @case A remainder that climbs out of the repository is refused
   * @preconditions A /tree/ URL containing a ".." segment
   * @expectedResult Throws, so nothing outside the clone is ever copied into the new project
   */
  test("refuses a remainder that escapes the repository", () => {
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
   * @preconditions A remainder whose segments contain dots but are not ".."
   * @expectedResult Parses, because the guard is per segment
   */
  test("keeps a remainder whose segments merely contain dots", () => {
    expect(
      parseGitHubExampleUrl("https://github.com/owner/repo/tree/main/v1..2/x"),
    ).toMatchObject({ remainder: "main/v1..2/x" });
  });
});

// ─── Unit: resolveExampleRef ─────────────────────────────────────────────────

describe("resolveExampleRef", () => {
  const refs = {
    heads: ["main", "claude/my-branch", "feat/acp", "release"],
    tags: ["v1.2.0", "v2.0.0-rc.1"],
  };

  /**
   * @case An empty remainder means the repository's default branch
   * @preconditions A plain repository URL
   * @expectedResult No ref, so the clone takes whatever the remote's HEAD is. Naming "main" here would break a repository whose default is called something else
   */
  test("an empty remainder takes the default branch", () => {
    expect(resolveExampleRef("", refs)).toEqual({
      ref: undefined,
      subPath: "",
    });
  });

  /**
   * @case A single-segment branch resolves to itself
   * @preconditions The remainder is exactly a branch name
   * @expectedResult That branch, and no subpath
   */
  test("resolves a single-segment branch", () => {
    expect(resolveExampleRef("main", refs)).toEqual({
      ref: "main",
      subPath: "",
    });
  });

  /**
   * @case A branch whose name contains a slash resolves whole
   * @preconditions The remainder is exactly a multi-segment branch name
   * @expectedResult The whole name as the ref. This is the case that was broken: it used to clone branch `claude` and look for `my-branch/` inside it
   */
  test("resolves a branch whose name contains a slash", () => {
    expect(resolveExampleRef("claude/my-branch", refs)).toEqual({
      ref: "claude/my-branch",
      subPath: "",
    });
  });

  /**
   * @case A multi-segment branch with a subpath under it
   * @preconditions The remainder is a slashed branch name followed by a path
   * @expectedResult The branch and the path, divided where the ref list says rather than at the first slash
   */
  test("resolves a slashed branch carrying a subpath", () => {
    expect(resolveExampleRef("feat/acp/examples/api", refs)).toEqual({
      ref: "feat/acp",
      subPath: "examples/api",
    });
  });

  /**
   * @case A single-segment branch with a subpath under it
   * @preconditions The remainder is a branch followed by a nested path
   * @expectedResult Branch and path, the case that already worked and must keep working
   */
  test("resolves a branch carrying a subpath", () => {
    expect(resolveExampleRef("main/examples/api", refs)).toEqual({
      ref: "main",
      subPath: "examples/api",
    });
  });

  /**
   * @case A tag resolves like a branch
   * @preconditions The remainder names a tag rather than a branch
   * @expectedResult The tag. `git clone --branch` takes either, so a /tree/v1.2.0 URL worked before this change and must not stop working
   */
  test("resolves a tag", () => {
    expect(resolveExampleRef("v1.2.0", refs)).toEqual({
      ref: "v1.2.0",
      subPath: "",
    });
    expect(resolveExampleRef("v1.2.0/examples", refs)).toEqual({
      ref: "v1.2.0",
      subPath: "examples",
    });
  });

  /**
   * @case The longest matching ref wins
   * @preconditions A remainder that a shorter ref also prefixes, which git itself cannot actually produce but the resolver must not depend on that
   * @expectedResult The longer ref, so a path is never mistaken for part of a branch name
   */
  test("prefers the longest matching ref", () => {
    const nested = {
      heads: ["release", "release/2024"],
      tags: [],
    };
    expect(resolveExampleRef("release/2024/examples", nested)).toEqual({
      ref: "release/2024",
      subPath: "examples",
    });
  });

  /**
   * @case A branch is preferred over a tag of the same name
   * @preconditions The two namespaces are separate, so one name can be both
   * @expectedResult The branch, which is what a /tree/ URL means when a browser produces one
   */
  test("prefers a branch over a tag of the same name", () => {
    const both = { heads: ["v1.2.0"], tags: ["v1.2.0"] };
    expect(resolveExampleRef("v1.2.0", both)).toEqual({
      ref: "v1.2.0",
      subPath: "",
    });
  });

  /**
   * @case A miss names the refs that do exist
   * @preconditions A remainder matching no branch and no tag
   * @expectedResult Throws naming the branches and tags available, because "make sure the repository is public" is not the problem when the repository just answered with its ref list
   */
  test("a miss names the refs that exist", () => {
    expect(() => resolveExampleRef("no-such-branch/x", refs)).toThrow(
      /No branch or tag matches "no-such-branch\/x"/,
    );
    expect(() => resolveExampleRef("no-such-branch/x", refs)).toThrow(
      /claude\/my-branch/,
    );
    expect(() => resolveExampleRef("no-such-branch/x", refs)).toThrow(
      /v1\.2\.0/,
    );
  });

  /**
   * @case A miss against a repository with many refs stays readable
   * @preconditions More refs than the message will name
   * @expectedResult The first few and a count, rather than six hundred lines answering a typo
   */
  test("a miss bounds how many refs it names", () => {
    const many = {
      heads: Array.from({ length: 25 }, (_, i) => `branch-${i}`),
      tags: [],
    };
    expect(() => resolveExampleRef("nope", many)).toThrow(/and 5 more/);
  });
});

// ─── Unit: clone containment ─────────────────────────────────────────────────

describe("clone containment", () => {
  /**
   * @case A symlinked example directory is refused
   * @preconditions A clone carrying a symlink that points outside it, which git stores and clones faithfully
   * @expectedResult Throws, because the check resolves real paths rather than comparing strings
   */
  test("refuses an example directory that is a symlink out of the clone", async () => {
    const root = await mkdtemp(join(tmpdir(), "rc-symlink-"));
    const clone = join(root, "clone");
    const outside = join(root, "outside");
    await mkdir(clone, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(clone, "examples"));

    expect(() =>
      assertInsideRepository(join(clone, "examples"), clone, "examples"),
    ).toThrow(/outside the repository/);

    await rm(root, { recursive: true, force: true });
  });

  /**
   * @case A symlink nested inside the example is refused
   * @preconditions A link below the example root, which the root containment check cannot see
   * @expectedResult isSymbolicLink reports it, so the copy filter skips it rather than
   *   planting a link to the author's machine in the generated project
   */
  test("detects a symlink nested below the example root", async () => {
    const root = await mkdtemp(join(tmpdir(), "rc-nested-link-"));
    const example = join(root, "example");
    await mkdir(example, { recursive: true });
    await symlink("/etc/passwd", join(example, "secrets"));

    expect(isSymbolicLink(join(example, "secrets"))).toBe(true);
    expect(isSymbolicLink(example)).toBe(false);

    await rm(root, { recursive: true, force: true });
  });

  /**
   * @case A real directory inside the clone is accepted
   * @preconditions An ordinary subdirectory, no symlink
   * @expectedResult No throw, so the guard does not refuse the normal case
   */
  test("accepts a real directory inside the clone", async () => {
    const root = await mkdtemp(join(tmpdir(), "rc-symlink-ok-"));
    const inside = join(root, "examples", "app");
    await mkdir(inside, { recursive: true });

    expect(() =>
      assertInsideRepository(inside, root, "examples/app"),
    ).not.toThrow();

    await rm(root, { recursive: true, force: true });
  });
});
