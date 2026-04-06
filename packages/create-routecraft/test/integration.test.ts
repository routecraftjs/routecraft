import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { execSync, type ExecSyncOptions } from "node:child_process";
import { generateProjectStructure, type InitOptions } from "../src/lib.js";

/**
 * Run a shell command, capturing stdout/stderr. On failure the output is
 * included in the thrown error so CI logs show what went wrong.
 */
function run(cmd: string, opts: ExecSyncOptions): void {
  try {
    execSync(cmd, { ...opts, stdio: "pipe" });
  } catch (error) {
    const err = error as { stdout?: Buffer; stderr?: Buffer; message: string };
    const stdout = err.stdout?.toString().trim();
    const stderr = err.stderr?.toString().trim();
    const details = [stdout, stderr].filter(Boolean).join("\n");
    throw new Error(`Command failed: ${cmd}\n${details}`);
  }
}

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

const MONOREPO_ROOT = join(__dirname, "../../..");

// Integration tests require monorepo packages to be built (dist/ must exist)
// so that file: protocol references can resolve types. In CI the test job runs
// before the build job, so these are skipped there.
const packagesBuilt = existsSync(
  join(MONOREPO_ROOT, "packages/routecraft/dist/index.d.ts"),
);
const integrationTest = packagesBuilt ? test : test.skip;

/**
 * Patch the scaffolded package.json to use local file: references
 * so integration tests don't depend on published npm versions.
 */
async function patchDepsToLocal(projectDir: string): Promise<void> {
  const pkgPath = join(projectDir, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));

  const localPackages: Record<string, string> = {
    "@routecraft/routecraft": `file:${join(MONOREPO_ROOT, "packages/routecraft")}`,
    "@routecraft/cli": `file:${join(MONOREPO_ROOT, "packages/cli")}`,
    "@routecraft/testing": `file:${join(MONOREPO_ROOT, "packages/testing")}`,
    "@routecraft/eslint-plugin-routecraft": `file:${join(MONOREPO_ROOT, "packages/eslint-plugin-routecraft")}`,
  };

  for (const [name, localPath] of Object.entries(localPackages)) {
    if (pkg.dependencies?.[name]) pkg.dependencies[name] = localPath;
    if (pkg.devDependencies?.[name]) pkg.devDependencies[name] = localPath;
  }

  // Also set pnpm overrides so transitive deps resolve locally
  pkg.pnpm = {
    ...(pkg.pnpm ?? {}),
    overrides: {
      ...(pkg.pnpm?.overrides ?? {}),
      ...localPackages,
    },
  };

  await writeFile(pkgPath, JSON.stringify(pkg, null, 2));
}

describe("integration: scaffolded project compiles", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = join(
      tmpdir(),
      `rc-integ-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  /**
   * @case Scaffolded empty project passes TypeScript type checking
   * @preconditions Empty project scaffolded, dependencies installed
   * @expectedResult tsc --noEmit exits without errors
   */
  integrationTest(
    "empty project passes tsc --noEmit",
    { timeout: 120_000 },
    async () => {
      await generateProjectStructure(
        projectDir,
        makeOptions({ packageManager: "pnpm" }),
      );
      await patchDepsToLocal(projectDir);

      run("pnpm install --no-frozen-lockfile", { cwd: projectDir });

      run("pnpm exec tsc --noEmit", { cwd: projectDir });
    },
  );

  /**
   * @case Scaffolded hello-world project passes TypeScript type checking
   * @preconditions Hello-world project scaffolded, dependencies installed
   * @expectedResult tsc --noEmit exits without errors
   */
  integrationTest(
    "hello-world project passes tsc --noEmit",
    { timeout: 120_000 },
    async () => {
      await generateProjectStructure(
        projectDir,
        makeOptions({ example: "hello-world", packageManager: "pnpm" }),
      );
      await patchDepsToLocal(projectDir);

      run("pnpm install --no-frozen-lockfile", { cwd: projectDir });

      run("pnpm exec tsc --noEmit", { cwd: projectDir });
    },
  );

  /**
   * @case Scaffolded hello-world project can be executed with craft run
   * @preconditions Hello-world project scaffolded, dependencies installed
   * @expectedResult craft run index.ts exits successfully (the hello-world route is finite)
   */
  integrationTest(
    "hello-world project runs successfully with craft run",
    { timeout: 120_000 },
    async () => {
      await generateProjectStructure(
        projectDir,
        makeOptions({ example: "hello-world", packageManager: "pnpm" }),
      );
      await patchDepsToLocal(projectDir);

      run("pnpm install --no-frozen-lockfile", { cwd: projectDir });

      // The hello-world route is finite (simple source produces one message then stops),
      // so craft run should exit on its own.
      run("pnpm exec craft run index.ts", {
        cwd: projectDir,
        timeout: 30_000,
      });
    },
  );

  /**
   * @case Scaffolded project file listing matches expected flat structure
   * @preconditions Hello-world project scaffolded
   * @expectedResult All files at root level, no src/ directory
   */
  test("hello-world project has correct flat file structure", async () => {
    await generateProjectStructure(
      projectDir,
      makeOptions({ example: "hello-world" }),
    );

    const entries = await readdir(projectDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);

    // Expected directories
    expect(dirs).toContain("capabilities");
    expect(dirs).toContain("adapters");
    expect(dirs).toContain("plugins");
    expect(dirs).not.toContain("src");

    // Expected files
    expect(files).toContain("index.ts");
    expect(files).toContain("package.json");
    expect(files).toContain("craft.config.ts");
    expect(files).toContain("tsconfig.json");
  });
});
