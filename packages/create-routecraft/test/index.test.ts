import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  generateProjectStructure,
  processTemplate,
  isUrl,
  type InitOptions,
} from "../src/lib.js";

// Suppress console output during tests
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
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
   * @case Hello-world example places capability file at capabilities/hello-world.ts
   * @preconditions example = "hello-world"
   * @expectedResult capabilities/hello-world.ts exists with route definition
   */
  test("hello-world example places capability file correctly", async () => {
    await generateProjectStructure(
      projectDir,
      makeOptions({ example: "hello-world" }),
    );

    const capPath = join(projectDir, "capabilities", "hello-world.ts");
    expect(existsSync(capPath)).toBe(true);

    const content = await readFile(capPath, "utf-8");
    expect(content).toContain("hello-world");
  });

  /**
   * @case Hello-world example places test file alongside capability
   * @preconditions example = "hello-world"
   * @expectedResult capabilities/hello-world.test.ts exists
   */
  test("hello-world example includes test file", async () => {
    await generateProjectStructure(
      projectDir,
      makeOptions({ example: "hello-world" }),
    );

    expect(
      existsSync(join(projectDir, "capabilities", "hello-world.test.ts")),
    ).toBe(true);
  });

  /**
   * @case Hello-world index.ts imports from ./capabilities/hello-world.js
   * @preconditions example = "hello-world"
   * @expectedResult index.ts contains correct relative import path
   */
  test("hello-world index.ts imports from ./capabilities/hello-world.js", async () => {
    await generateProjectStructure(
      projectDir,
      makeOptions({ example: "hello-world" }),
    );

    const content = await readFile(join(projectDir, "index.ts"), "utf-8");
    expect(content).toContain('from "./capabilities/hello-world.js"');
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
   * @case package.json start script points to index.ts at root
   * @preconditions Default options
   * @expectedResult start script is "craft run index.ts --log-level info"
   */
  test("package.json start script points to root index.ts", async () => {
    await generateProjectStructure(projectDir, makeOptions());

    const pkg = await readJson(join(projectDir, "package.json"));
    const scripts = pkg.scripts;
    expect(scripts.start).toBe("craft run index.ts --log-level info");
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
   * @expectedResult .gitignore, .prettierrc, craft.config.ts, eslint.config.mjs, tsconfig.json, vitest.config.ts exist
   */
  test("all config files are present at project root", async () => {
    await generateProjectStructure(projectDir, makeOptions());

    const expectedFiles = [
      ".gitignore",
      ".prettierrc",
      "craft.config.ts",
      "eslint.config.mjs",
      "tsconfig.json",
      "vitest.config.ts",
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
