import { describe, test, expect } from "vitest";
import { mkdir, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { exec, type ExecOptions } from "node:child_process";
import { promisify } from "node:util";
import { generateProjectStructure, type InitOptions } from "../src/lib.js";

const execAsync = promisify(exec);

/**
 * Run a shell command, capturing stdout/stderr. On failure the output is
 * included in the thrown error so CI logs show what went wrong.
 *
 * Uses async exec (not execSync) so concurrent tests can actually overlap;
 * execSync would block the event loop and serialise them.
 */
async function run(cmd: string, opts: ExecOptions): Promise<void> {
  try {
    await execAsync(cmd, opts);
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message: string };
    const stdout = err.stdout?.trim();
    const stderr = err.stderr?.trim();
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

/**
 * Allocate a fresh tmpdir for a single test and guarantee cleanup. Using a
 * per-test helper (instead of shared describe-scoped state) lets the
 * install-heavy tests run with test.concurrent without racing on the path.
 */
async function withProjectDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = join(
    tmpdir(),
    `rc-integ-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("integration: scaffolded project compiles", () => {
  /**
   * @case Scaffolded empty project passes TypeScript type checking
   * @preconditions Empty project scaffolded, dependencies installed
   * @expectedResult tsc --noEmit exits without errors
   */
  integrationTest.concurrent(
    "empty project passes tsc --noEmit",
    { timeout: 120_000 },
    async () => {
      await withProjectDir(async (projectDir) => {
        await generateProjectStructure(
          projectDir,
          makeOptions({ packageManager: "pnpm" }),
        );
        await patchDepsToLocal(projectDir);

        await run("pnpm install --no-frozen-lockfile", { cwd: projectDir });

        await run("pnpm exec tsc --noEmit", { cwd: projectDir });
      });
    },
  );

  /**
   * @case Scaffolded hello-world project type-checks and runs successfully
   * @preconditions Hello-world project scaffolded, dependencies installed
   * @expectedResult tsc --noEmit passes and craft run exits successfully
   */
  integrationTest.concurrent(
    "hello-world project type-checks and runs via craft",
    { timeout: 120_000 },
    async () => {
      await withProjectDir(async (projectDir) => {
        await generateProjectStructure(
          projectDir,
          makeOptions({ example: "hello-world", packageManager: "pnpm" }),
        );
        await patchDepsToLocal(projectDir);

        await run("pnpm install --no-frozen-lockfile", { cwd: projectDir });

        await run("pnpm exec tsc --noEmit", { cwd: projectDir });

        // The hello-world route is finite (simple source produces one message then stops),
        // so craft run should exit on its own.
        await run("pnpm exec craft run index.ts", {
          cwd: projectDir,
          timeout: 30_000,
        });
      });
    },
  );

  /**
   * @case Scaffolded project file listing matches expected flat structure
   * @preconditions Hello-world project scaffolded
   * @expectedResult All files at root level, no src/ directory
   */
  test.concurrent(
    "hello-world project has correct flat file structure",
    async () => {
      await withProjectDir(async (projectDir) => {
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
    },
  );
});
