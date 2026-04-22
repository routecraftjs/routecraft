import { describe, test, expect } from "vitest";
import { mkdir, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { exec, execSync, spawn, type ExecOptions } from "node:child_process";
import { promisify } from "node:util";
import { generateProjectStructure, type InitOptions } from "../src/lib.js";

const execAsync = promisify(exec);

type PackageManagerId = "npm" | "bun";

interface PackageManagerDef {
  id: PackageManagerId;
  pmOption: Required<InitOptions>["packageManager"];
  install: string;
  typecheck: string;
  /**
   * Runs the scaffolded project via `craft run index.ts`. For bun we force the
   * bun runtime (via `--bun`) so the CLI executes on bun, not on node.
   */
  start: string;
}

const PACKAGE_MANAGER_DEFS: Record<PackageManagerId, PackageManagerDef> = {
  npm: {
    id: "npm",
    pmOption: "npm",
    install: "npm install --no-audit --no-fund",
    typecheck: "npx tsc --noEmit",
    start: "npx craft run index.ts",
  },
  bun: {
    id: "bun",
    pmOption: "bun",
    install: "bun install",
    typecheck: "bunx tsc --noEmit",
    // `bun x --bun` forces bun runtime on the spawned binary (the craft bin
    // has a `#!/usr/bin/env node` shebang which would otherwise invoke node).
    start: "bun x --bun craft run index.ts",
  },
};

function selectedPackageManager(): PackageManagerDef {
  const id = (process.env["TEST_PACKAGE_MANAGER"] ?? "npm") as PackageManagerId;
  const def = PACKAGE_MANAGER_DEFS[id];
  if (!def) {
    throw new Error(
      `Unknown TEST_PACKAGE_MANAGER: ${id}. Must be one of: ${Object.keys(
        PACKAGE_MANAGER_DEFS,
      ).join(", ")}`,
    );
  }
  return def;
}

const pm = selectedPackageManager();

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

/**
 * Run a long-running command and resolve as soon as the expected substring
 * appears on stdout or stderr. Kills the process once matched.
 *
 * Needed because the hello-world example includes a direct source that keeps
 * the context alive after the caller route finishes; we assert success by
 * observing output rather than waiting for natural exit.
 */
async function runUntilOutput(
  cmd: string,
  opts: {
    cwd: string;
    expectedOutput: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
  },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", cmd], {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    // Kill the child with SIGTERM, wait up to 2s for exit, then SIGKILL. This
    // avoids EPIPE noise from orphaned writes racing the next test.
    const finish = async (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGTERM");
        } catch {
          // already dead
        }
        await new Promise<void>((r) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            r();
            return;
          }
          const killTimer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // already dead
            }
            r();
          }, 2000);
          child.once("exit", () => {
            clearTimeout(killTimer);
            r();
          });
        });
      }
      fn();
    };

    const timer = setTimeout(() => {
      void finish(() =>
        reject(
          new Error(
            `Timed out waiting for "${opts.expectedOutput}" after ${opts.timeoutMs}ms.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        ),
      );
    }, opts.timeoutMs);

    const check = () => {
      if (
        stdout.includes(opts.expectedOutput) ||
        stderr.includes(opts.expectedOutput)
      ) {
        void finish(() => resolve());
      }
    };

    child.stdout?.on("data", (d) => {
      stdout += d.toString();
      check();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
      check();
    });
    child.on("exit", (code) => {
      if (settled) return;
      if (
        stdout.includes(opts.expectedOutput) ||
        stderr.includes(opts.expectedOutput)
      ) {
        void finish(() => resolve());
      } else {
        void finish(() =>
          reject(
            new Error(
              `Process exited with code ${code} before emitting "${opts.expectedOutput}".\nstdout:\n${stdout}\nstderr:\n${stderr}`,
            ),
          ),
        );
      }
    });
    child.on("error", (err) => {
      void finish(() => reject(err));
    });
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeOptions(
  overrides: Partial<Required<InitOptions>> = {},
): Required<InitOptions> {
  return {
    projectName: "test-app",
    example: "none",
    packageManager: pm.pmOption,
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

// Rebuild the routecraft package so its dist/ matches the checked-out
// source. On local runs this catches stale dist after editing source without
// running `pnpm build`. On CI it is a belt-and-suspenders against cache
// issues on the `pull_request_target` workflow (see cache key scoping in
// ci.yml). Cheap — one tsup run on a single package.
if (packagesBuilt) {
  execSync("pnpm --filter @routecraft/routecraft build", {
    cwd: MONOREPO_ROOT,
    stdio: "inherit",
  });
}

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

  // npm and bun honour top-level `overrides`; pnpm uses `pnpm.overrides`.
  pkg.overrides = { ...(pkg.overrides ?? {}), ...localPackages };
  pkg.pnpm = {
    ...(pkg.pnpm ?? {}),
    overrides: { ...(pkg.pnpm?.overrides ?? {}), ...localPackages },
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

describe(`integration (${pm.id}): scaffolded project compiles`, () => {
  /**
   * @case Scaffolded empty project passes TypeScript type checking
   * @preconditions Empty project scaffolded, dependencies installed via the selected package manager
   * @expectedResult tsc --noEmit exits without errors
   */
  integrationTest.concurrent(
    "empty project passes tsc --noEmit",
    { timeout: 180_000 },
    async () => {
      await withProjectDir(async (projectDir) => {
        await generateProjectStructure(projectDir, makeOptions());
        await patchDepsToLocal(projectDir);

        await run(pm.install, { cwd: projectDir });

        await run(pm.typecheck, { cwd: projectDir });
      });
    },
  );

  /**
   * @case Scaffolded hello-world project type-checks and dispatches simple -> direct on the selected package manager
   * @preconditions Hello-world project scaffolded, dependencies installed via the selected package manager
   * @expectedResult tsc --noEmit passes and the greet route logs "Hello, Leanne Graham!" within the timeout
   */
  integrationTest.concurrent(
    "hello-world project type-checks and dispatches simple -> direct via craft",
    { timeout: 180_000 },
    async () => {
      await withProjectDir(async (projectDir) => {
        await generateProjectStructure(
          projectDir,
          makeOptions({ example: "hello-world" }),
        );
        await patchDepsToLocal(projectDir);

        await run(pm.install, { cwd: projectDir });

        await run(pm.typecheck, { cwd: projectDir });

        // The hello-world caller is finite, but the direct listener keeps the
        // context alive, so we wait for the greeting in the logs and then
        // terminate the process rather than wait for natural exit.
        // CRAFT_LOG_LEVEL=info ensures the greeting reaches the log stream
        // (default level is warn).
        await runUntilOutput(pm.start, {
          cwd: projectDir,
          expectedOutput: "Hello, Leanne Graham!",
          timeoutMs: 60_000,
          env: { CRAFT_LOG_LEVEL: "info" },
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
