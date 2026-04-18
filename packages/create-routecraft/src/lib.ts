/* eslint-disable no-console */

import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import { input, select, confirm } from "@inquirer/prompts";
import { tmpdir } from "node:os";
import { cp, rm } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, "../templates");

/**
 * Package manager types
 */
type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/**
 * Example types
 */
type ExampleType = string;

/**
 * Project initialization options
 * @experimental
 */
export interface InitOptions {
  projectName?: string;
  example?: ExampleType;
  packageManager?: PackageManager;
  skipInstall?: boolean;
  git?: boolean;
  force?: boolean;
  yes?: boolean;
}

/**
 * Get the current version of @routecraft/routecraft from package.json
 * @experimental
 */
export function getRoutecraftVersion(): string {
  try {
    // Try to read the package.json of the routecraft package
    const packagePath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../routecraft/package.json",
    );
    if (existsSync(packagePath)) {
      const pkg = JSON.parse(readFileSync(packagePath, "utf-8"));
      return `^${pkg.version}`;
    }
  } catch {
    // Fallback if we can't read the package.json
  }

  // Default fallback - use "latest" to always get the newest version
  return "latest";
}

/**
 * Get package manager with version
 */
function getPackageManagerVersion(packageManager: PackageManager): string {
  const versions: Record<PackageManager, string> = {
    pnpm: "pnpm@10.17.1",
    npm: "npm@10.0.0",
    yarn: "yarn@4.0.0",
    bun: "bun@1.3.9",
  };
  return versions[packageManager];
}

/**
 * Process template content with replacements
 * @experimental
 */
export function processTemplate(
  content: string,
  replacements: Record<string, string>,
): string {
  let processed = content;
  for (const [key, value] of Object.entries(replacements)) {
    processed = processed.replaceAll(key, value);
  }
  return processed;
}

/**
 * Check if an example string is a URL
 * @experimental
 */
export function isUrl(example: string): boolean {
  return example.startsWith("http://") || example.startsWith("https://");
}

/**
 * Validate that the downloaded content contains expected Routecraft project files
 * @param sourceDir Path to the source directory to validate
 */
async function validateExampleContent(sourceDir: string): Promise<void> {
  try {
    const files = await readdir(sourceDir);

    // Check for basic project structure indicators
    const hasPackageJson = files.includes("package.json");
    const hasRouteFiles = files.some(
      (file) =>
        file.endsWith(".ts") ||
        file.endsWith(".js") ||
        file.endsWith(".mjs") ||
        file.includes("route"),
    );

    // Check if there are subdirectories that might contain routes
    let hasRouteSubdirs = false;
    for (const file of files) {
      const filePath = join(sourceDir, file);
      const fileStat = await stat(filePath);
      if (fileStat.isDirectory()) {
        const subFiles = await readdir(filePath);
        if (
          subFiles.some(
            (f) => f.endsWith(".ts") || f.endsWith(".js") || f.endsWith(".mjs"),
          )
        ) {
          hasRouteSubdirs = true;
          break;
        }
      }
    }

    if (!hasPackageJson && !hasRouteFiles && !hasRouteSubdirs) {
      throw new Error(
        "Downloaded content doesn't appear to be a valid Routecraft project. " +
          "Expected to find package.json or route files (.ts, .js, .mjs).",
      );
    }

    console.log("✅ Downloaded content validated successfully");
  } catch (error) {
    throw new Error(
      `Content validation failed: ${error instanceof Error ? error.message : error}`,
    );
  }
}

/**
 * Download and extract a GitHub example
 */
async function downloadGitHubExample(url: string): Promise<string> {
  const tempDir = join(tmpdir(), `routecraft-example-${Date.now()}`);

  try {
    console.log(`📥 Downloading example from ${url}...`);

    // Regex supports multi-segment branches (e.g. feature/my-branch)
    const urlPattern =
      /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+?)\/(.+))?$/;
    const match = url.match(urlPattern);

    if (!match) {
      throw new Error(`Invalid GitHub URL format: ${url}`);
    }

    const [, owner, repo, branch = "main", subPath = ""] = match;
    const repoUrl = `https://github.com/${owner}/${repo}.git`;

    try {
      const args = ["clone", "--depth", "1"];
      if (branch) {
        args.push("--branch", branch);
      }
      args.push(repoUrl, tempDir);
      execFileSync("git", args, { stdio: "inherit" });
    } catch {
      throw new Error(
        `Failed to clone repository. Make sure the repository is public and accessible: ${repoUrl}`,
      );
    }

    const sourceDir = subPath ? join(tempDir, subPath) : tempDir;

    if (!existsSync(sourceDir)) {
      throw new Error(`Path ${subPath} not found in repository`);
    }

    await validateExampleContent(sourceDir);

    return sourceDir;
  } catch (error) {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    throw new Error(`Failed to download example from ${url}: ${error}`);
  }
}

/**
 * Main entry point for create-routecraft
 * This is called by npm create routecraft <project-name>
 * @experimental
 */
export async function main() {
  const args = process.argv.slice(2);

  // Check for help flag first
  if (args.includes("--help") || args.includes("-h")) {
    showHelp();
    process.exit(0);
  }

  // npm create passes the project name as the first argument
  const projectName = args[0];

  // Parse additional arguments (skip project name if present)
  const remainingArgs = projectName ? args.slice(1) : args;
  const options: Record<string, unknown> = {};

  for (let i = 0; i < remainingArgs.length; i++) {
    const arg = remainingArgs[i];

    if (arg === "--example" || arg === "-e") {
      options["example"] = remainingArgs[i + 1];
      i++;
    } else if (arg === "--use-npm") {
      options["packageManager"] = "npm";
    } else if (arg === "--use-pnpm") {
      options["packageManager"] = "pnpm";
    } else if (arg === "--use-yarn") {
      options["packageManager"] = "yarn";
    } else if (arg === "--use-bun") {
      options["packageManager"] = "bun";
    } else if (arg === "--skip-install") {
      options["skipInstall"] = true;
    } else if (arg === "--no-git") {
      options["git"] = false;
    } else if (arg === "--yes" || arg === "-y") {
      options["yes"] = true;
    } else if (arg === "--force" || arg === "-f") {
      options["force"] = true;
    } else if (arg === "--help" || arg === "-h") {
      showHelp();
      process.exit(0);
    }
  }

  try {
    await initCommand(projectName, options);
  } catch (error) {
    console.error("❌ Failed to create Routecraft project:", error);
    process.exit(1);
  }
}

/**
 * Initialize a new Routecraft project
 */
async function initCommand(
  projectName?: string,
  options: Record<string, unknown> = {},
) {
  try {
    const answers = await getUserInput(projectName, options);

    const projectDir = resolve(process.cwd(), answers.projectName);
    await createProjectDirectory(projectDir, answers.force);

    await generateProjectStructure(projectDir, answers);

    if (answers.git) {
      await initializeGit(projectDir);
    }

    if (!answers.skipInstall) {
      await installDependencies(projectDir, answers.packageManager);
    }

    console.log(`
🎉 Successfully created Routecraft project: ${answers.projectName}

Next steps:
  cd ${answers.projectName}
  ${answers.skipInstall ? `${getPackageManagerCommand(answers.packageManager)} install\n  ` : ""}${getPackageManagerCommand(answers.packageManager)} run start

For more information, visit: https://routecraft.dev
    `);
  } catch (error) {
    console.error(`Failed to initialize project: ${error}`);
    process.exit(1);
  }
}

/**
 * Get user input through prompts or use provided options
 * @experimental
 */
export async function getUserInput(
  projectName?: string,
  options: Record<string, unknown> = {},
): Promise<Required<InitOptions>> {
  const skipPrompts = options["yes"] === true;

  const answers: Required<InitOptions> = {
    projectName:
      projectName ||
      (skipPrompts
        ? "my-routecraft-app"
        : await input({
            message: "What is your project named?",
            default: "my-routecraft-app",
            validate: (value: string) =>
              value.length > 0 || "Project name cannot be empty",
          })),

    example:
      (options["example"] as ExampleType) ||
      (skipPrompts
        ? "none"
        : await select<string>({
            message: "Choose an example:",
            choices: [
              { name: "None - empty project", value: "none" },
              { name: "Hello World - basic example", value: "hello-world" },
              { name: "Custom URL (GitHub)", value: "custom-url" },
            ],
            default: "none",
          }).then(async (choice) => {
            if (choice === "custom-url") {
              return await input({
                message: "Enter GitHub URL:",
                validate: (value: string) => {
                  if (isUrl(value)) return true;
                  return "Must be a valid GitHub URL";
                },
              });
            }
            return choice;
          })),

    packageManager:
      (options["packageManager"] as PackageManager) ||
      (skipPrompts
        ? "bun"
        : await select<PackageManager>({
            message: "Package manager:",
            choices: [
              { name: "bun", value: "bun" },
              { name: "npm", value: "npm" },
              { name: "pnpm", value: "pnpm" },
              { name: "yarn", value: "yarn" },
            ],
            default: "bun",
          })),

    git:
      (options["git"] as boolean) ??
      (skipPrompts
        ? true
        : await confirm({
            message: "Initialize git:",
            default: true,
          })),

    skipInstall:
      (options["skipInstall"] as boolean) ??
      (skipPrompts
        ? false
        : !(await confirm({
            message: "Install dependencies now:",
            default: true,
          }))),

    force: (options["force"] as boolean) ?? false,

    yes: skipPrompts,
  };

  return answers;
}

/**
 * Create project directory
 */
async function createProjectDirectory(
  projectDir: string,
  force: boolean = false,
) {
  if (existsSync(projectDir)) {
    if (!force) {
      throw new Error(
        `Directory "${projectDir}" already exists. Use --force to overwrite.`,
      );
    } else {
      console.log(`⚠️  Overwriting existing directory: ${projectDir}`);
      await rm(projectDir, { recursive: true, force: true });
    }
  }

  await mkdir(projectDir, { recursive: true });
  console.log(`Created project directory: ${projectDir}`);
}

/**
 * Generate project structure from template
 * @experimental
 */
export async function generateProjectStructure(
  projectDir: string,
  options: Required<InitOptions>,
) {
  const hasExample = options.example !== "none";

  // Create base directories
  await mkdir(join(projectDir, "capabilities"), { recursive: true });
  await mkdir(join(projectDir, "adapters"), { recursive: true });
  await mkdir(join(projectDir, "plugins"), { recursive: true });

  // Template files mapping (source -> destination)
  const templateFiles: Record<string, string> = {
    gitignore: ".gitignore",
    ".prettierrc": ".prettierrc",
    "craft.config.ts": "craft.config.ts",
    "eslint.config.mjs": "eslint.config.mjs",
    "tsconfig.json": "tsconfig.json",
    "vitest.config.ts": "vitest.config.ts",
  };

  const routecraftVersion = getRoutecraftVersion();

  // Copy base template files
  for (const [sourceFile, destFile] of Object.entries(templateFiles)) {
    const sourcePath = join(TEMPLATES_DIR, "base", sourceFile);
    const destPath = join(projectDir, destFile);

    const content = await readFile(sourcePath, "utf-8");
    await writeFile(destPath, content);
    console.log(`Created file: ${destFile}`);
  }

  // Handle package.json with replacements
  const packageJsonSource = join(TEMPLATES_DIR, "base", "package.json");
  let packageJsonContent = await readFile(packageJsonSource, "utf-8");
  packageJsonContent = processTemplate(packageJsonContent, {
    PROJECT_NAME: options.projectName,
    ROUTECRAFT_VERSION: routecraftVersion,
    PACKAGE_MANAGER: getPackageManagerVersion(options.packageManager),
  });
  await writeFile(join(projectDir, "package.json"), packageJsonContent);
  console.log(`Created file: package.json`);

  // Handle index.ts based on whether a built-in example is included.
  // URL examples supply their own index.ts via cp(), so use the empty template as a fallback.
  const hasBuiltInExample = hasExample && !isUrl(options.example);
  const indexTemplate = hasBuiltInExample
    ? "index-with-example.ts"
    : "index-empty.ts";
  const indexSource = join(TEMPLATES_DIR, "base", indexTemplate);
  const indexContent = await readFile(indexSource, "utf-8");

  await writeFile(join(projectDir, "index.ts"), indexContent);
  console.log(`Created file: index.ts`);

  // Add example routes if requested
  if (options.example !== "none") {
    if (isUrl(options.example)) {
      // Handle GitHub URL examples
      const tempExampleDir = await downloadGitHubExample(options.example);
      try {
        await cp(tempExampleDir, projectDir, {
          recursive: true,
          force: true,
          filter: (src) => {
            const relativePath = src
              .replace(tempExampleDir, "")
              .replace(/^\//, "");
            return (
              !relativePath.includes("node_modules") &&
              !relativePath.includes(".git") &&
              !relativePath.includes("package-lock.json") &&
              !relativePath.includes("yarn.lock") &&
              !relativePath.includes("pnpm-lock.yaml")
            );
          },
        });
        console.log(`✅ Added example from ${options.example}`);
      } finally {
        try {
          await rm(tempExampleDir, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors
        }
      }
    } else {
      // Handle built-in examples - copy from templates/examples/
      const exampleDir = join(TEMPLATES_DIR, "examples", options.example);
      if (existsSync(exampleDir)) {
        await cp(exampleDir, projectDir, {
          recursive: true,
          force: false,
          // deps.json is metadata for dependency injection, not project content.
          filter: (src) => !src.endsWith(`${options.example}/deps.json`),
        });

        await mergeExampleDeps(exampleDir, projectDir);

        console.log(`✅ Added ${options.example} example`);
      } else {
        throw new Error(`Unknown example: ${options.example}`);
      }
    }
  }

  console.log("Generated project structure");
}

/**
 * Merge an example's optional `deps.json` (dependencies / devDependencies)
 * into the scaffolded `package.json`. Lets per-example deps (e.g. zod for the
 * hello-world schema) be declared next to the example instead of bloating the
 * base template for users who pick "none".
 */
async function mergeExampleDeps(
  exampleDir: string,
  projectDir: string,
): Promise<void> {
  const depsPath = join(exampleDir, "deps.json");
  if (!existsSync(depsPath)) return;

  const exampleDeps = JSON.parse(await readFile(depsPath, "utf-8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  const pkgPath = join(projectDir, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));

  if (exampleDeps.dependencies) {
    pkg.dependencies = { ...pkg.dependencies, ...exampleDeps.dependencies };
  }
  if (exampleDeps.devDependencies) {
    pkg.devDependencies = {
      ...pkg.devDependencies,
      ...exampleDeps.devDependencies,
    };
  }

  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}

/**
 * Initialize git repository
 */
async function initializeGit(projectDir: string) {
  try {
    execSync("git init", { cwd: projectDir, stdio: "inherit" });
    execSync("git add .", { cwd: projectDir, stdio: "inherit" });
    execSync('git commit -m "Initial commit"', {
      cwd: projectDir,
      stdio: "inherit",
    });
    console.log("Initialized git repository");
  } catch {
    console.warn("Failed to initialize git repository");
  }
}

/**
 * Install project dependencies
 */
async function installDependencies(
  projectDir: string,
  packageManager: PackageManager,
) {
  const command = getPackageManagerCommand(packageManager);
  try {
    execSync(`${command} install`, { cwd: projectDir, stdio: "inherit" });
    console.log("Installed dependencies");
  } catch {
    console.warn(
      `Failed to install dependencies. Run "${command} install" manually.`,
    );
  }
}

/**
 * Get package manager command
 */
function getPackageManagerCommand(packageManager: PackageManager): string {
  switch (packageManager) {
    case "npm":
      return "npm";
    case "pnpm":
      return "pnpm";
    case "yarn":
      return "yarn";
    case "bun":
      return "bun";
    default:
      return "bun";
  }
}

function showHelp() {
  console.log(`
Create a new Routecraft project

Usage:
  bunx create-routecraft <project-name> [options]
  npm create routecraft@latest <project-name> [options]
  npx create-routecraft <project-name> [options]

Options:
  -e, --example <name|url>  Example to include (none, hello-world) or GitHub URL
  --use-bun                 Use bun as package manager (default)
  --use-npm                 Use npm as package manager
  --use-pnpm                Use pnpm as package manager
  --use-yarn                Use yarn as package manager
  --skip-install            Skip installing dependencies
  --no-git                  Skip git initialization
  -y, --yes                 Skip interactive prompts and use defaults
  -f, --force               Overwrite existing directory
  -h, --help                Show this help message

Examples:
  bunx create-routecraft my-app
  bunx create-routecraft my-app --example hello-world
  bunx create-routecraft my-app --yes --example hello-world
  bunx create-routecraft my-app --force
  bunx create-routecraft my-app --example https://github.com/user/repo
  bunx create-routecraft my-app --example https://github.com/user/repo/tree/main/examples/api
`);
}
