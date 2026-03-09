#!/usr/bin/env node

/* eslint-disable no-console */

import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
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
 */
interface InitOptions {
  projectName?: string;
  example?: ExampleType;
  packageManager?: PackageManager;
  useSrcDir?: boolean;
  skipInstall?: boolean;
  git?: boolean;
  force?: boolean;
  yes?: boolean;
}

/**
 * Get the current version of @routecraft/routecraft from package.json
 */
function getRoutecraftVersion(): string {
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
  // In a real implementation, you might want to detect installed versions
  // For now, we'll use sensible defaults
  const versions: Record<PackageManager, string> = {
    pnpm: "pnpm@10.17.1",
    npm: "npm@10.0.0",
    yarn: "yarn@4.0.0",
    bun: "bun@1.0.0",
  };
  return versions[packageManager];
}

/**
 * Read and process a template file
 */
async function readTemplateFile(filePath: string): Promise<string> {
  const content = await readFile(filePath, "utf-8");
  return content;
}

/**
 * Process template content with replacements
 */
function processTemplate(
  content: string,
  replacements: Record<string, string>,
): string {
  let processed = content;
  for (const [key, value] of Object.entries(replacements)) {
    processed = processed.replaceAll(key, value);
  }
  return processed;
}

// Template files are now stored in the templates/ directory

/**
 * Check if an example string is a URL
 */
function isUrl(example: string): boolean {
  return example.startsWith("http://") || example.startsWith("https://");
}

/**
 * Validate that the downloaded content contains expected RouteCraft project files
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
        "Downloaded content doesn't appear to be a valid RouteCraft project. " +
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

    // For GitHub URLs, we'll use git clone for simplicity
    // Extract repo info from URL
    const urlPattern =
      /^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)\/(.+))?$/;
    const match = url.match(urlPattern);

    if (!match) {
      throw new Error(`Invalid GitHub URL format: ${url}`);
    }

    const [, owner, repo, branch = "main", subPath = ""] = match;
    const repoUrl = `https://github.com/${owner}/${repo}.git`;

    // Clone the repo (try with credentials if available, fallback to public access)
    try {
      execSync(
        `git clone --depth 1 ${branch ? `--branch ${branch}` : ""} ${repoUrl} ${tempDir}`,
        {
          stdio: "inherit",
        },
      );
    } catch {
      // If git clone fails, try a different approach or provide better error
      throw new Error(
        `Failed to clone repository. Make sure the repository is public and accessible: ${repoUrl}`,
      );
    }

    // If there's a subPath, use that subdirectory
    const sourceDir = subPath ? join(tempDir, subPath) : tempDir;

    if (!existsSync(sourceDir)) {
      throw new Error(`Path ${subPath} not found in repository`);
    }

    // Validate downloaded content structure
    await validateExampleContent(sourceDir);

    return sourceDir;
  } catch (error) {
    // Cleanup on error
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
 */
async function main() {
  const args = process.argv.slice(2);

  // Check for help flag first
  if (args.includes("--help") || args.includes("-h")) {
    showHelp();
    process.exit(0);
  }

  // npm create passes the project name as the first argument
  const projectName = args[0];

  if (!projectName) {
    console.error("❌ Project name is required");
    console.log("Usage: npm create routecraft@latest <project-name> [options]");
    console.log("Or:    npx create-routecraft <project-name> [options]");
    console.log("Run with --help for more information");
    process.exit(1);
  }

  // Parse additional arguments
  const remainingArgs = args.slice(1);
  const options: Record<string, unknown> = {};

  // Simple argument parsing for common options
  for (let i = 0; i < remainingArgs.length; i++) {
    const arg = remainingArgs[i];

    if (arg === "--example" || arg === "-e") {
      options["example"] = remainingArgs[i + 1];
      i++; // Skip next arg
    } else if (arg === "--use-npm") {
      options["packageManager"] = "npm";
    } else if (arg === "--use-pnpm") {
      options["packageManager"] = "pnpm";
    } else if (arg === "--use-yarn") {
      options["packageManager"] = "yarn";
    } else if (arg === "--use-bun") {
      options["packageManager"] = "bun";
    } else if (arg === "--no-src-dir") {
      options["useSrcDir"] = false;
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
    console.error("❌ Failed to create RouteCraft project:", error);
    process.exit(1);
  }
}

/**
 * Initialize a new RouteCraft project
 */
async function initCommand(
  projectName?: string,
  options: Record<string, unknown> = {},
) {
  try {
    // Interactive prompts if values not provided
    const answers = await getUserInput(projectName, options);

    // Create project directory
    const projectDir = resolve(process.cwd(), answers.projectName);
    await createProjectDirectory(projectDir, answers.force);

    // Generate project structure
    await generateProjectStructure(projectDir, answers);

    // Initialize git if requested
    if (answers.git) {
      await initializeGit(projectDir);
    }

    // Install dependencies if requested
    if (!answers.skipInstall) {
      await installDependencies(projectDir, answers.packageManager);
    }

    // Success message
    console.log(`
🎉 Successfully created RouteCraft project: ${answers.projectName}

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
 */
async function getUserInput(
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
        ? "npm"
        : await select<PackageManager>({
            message: "Package manager:",
            choices: [
              { name: "npm", value: "npm" },
              { name: "pnpm", value: "pnpm" },
              { name: "yarn", value: "yarn" },
              { name: "bun", value: "bun" },
            ],
            default: "npm",
          })),

    useSrcDir:
      (options["useSrcDir"] as boolean) ??
      (skipPrompts
        ? false
        : await confirm({
            message: "Use src directory:",
            default: false,
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
    }
  }

  await mkdir(projectDir, { recursive: true });
  console.log(`Created project directory: ${projectDir}`);
}

/**
 * Generate project structure from template
 */
async function generateProjectStructure(
  projectDir: string,
  options: Required<InitOptions>,
) {
  const baseDir = options.useSrcDir ? join(projectDir, "src") : projectDir;
  const hasExample = options.example !== "none";

  // Create base directories
  await mkdir(join(baseDir, "capabilities"), { recursive: true });
  await mkdir(join(baseDir, "adapters"), { recursive: true });
  await mkdir(join(baseDir, "plugins"), { recursive: true });

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

    const content = await readTemplateFile(sourcePath);
    await writeFile(destPath, content);
    console.log(`Created file: ${destFile}`);
  }

  // Handle package.json with replacements
  const packageJsonSource = join(TEMPLATES_DIR, "base", "package.json");
  let packageJsonContent = await readTemplateFile(packageJsonSource);
  packageJsonContent = processTemplate(packageJsonContent, {
    PROJECT_NAME: options.projectName,
    ROUTECRAFT_VERSION: routecraftVersion,
    PACKAGE_MANAGER: getPackageManagerVersion(options.packageManager),
  });
  await writeFile(join(projectDir, "package.json"), packageJsonContent);
  console.log(`Created file: package.json`);

  // Handle index.ts based on whether example is included
  const indexTemplate = hasExample ? "index-with-example.ts" : "index-empty.ts";
  const indexSource = join(TEMPLATES_DIR, "base", indexTemplate);
  let indexContent = await readTemplateFile(indexSource);

  // Replace import path based on useSrcDir
  const capabilitiesPath = options.useSrcDir
    ? "./src/capabilities"
    : "./capabilities";
  indexContent = processTemplate(indexContent, {
    CAPABILITIES_IMPORT_PATH: capabilitiesPath,
  });

  await writeFile(join(projectDir, "index.ts"), indexContent);
  console.log(`Created file: index.ts`);

  // Add example routes if requested
  if (options.example !== "none") {
    if (isUrl(options.example)) {
      // Handle GitHub URL examples
      const tempExampleDir = await downloadGitHubExample(options.example);
      try {
        // Copy all files from the downloaded example to the base directory
        await cp(tempExampleDir, baseDir, {
          recursive: true,
          force: true,
          filter: (src) => {
            // Skip node_modules, .git, and other unwanted directories
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
        // Cleanup temp directory
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
        await cp(exampleDir, baseDir, {
          recursive: true,
          force: false,
        });
        console.log(`✅ Added ${options.example} example`);
      } else {
        throw new Error(`Unknown example: ${options.example}`);
      }
    }
  }

  // Update package.json scripts if using src directory
  if (options.useSrcDir) {
    const packageJsonPath = join(projectDir, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf-8"));
    packageJson.scripts = {
      ...packageJson.scripts,
      build: "tsc",
      start: "craft run src/index.ts",
    };
    await writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
  }

  console.log("Generated project structure");
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
      return "npm";
  }
}

function showHelp() {
  console.log(`
Create a new RouteCraft project

Usage:
  npm create routecraft@latest <project-name> [options]
  npx create-routecraft <project-name> [options]

Options:
  -e, --example <name|url>  Example to include (none, hello-world) or GitHub URL
  --use-npm                 Use npm as package manager
  --use-pnpm                Use pnpm as package manager
  --use-yarn                Use yarn as package manager
  --use-bun                 Use bun as package manager
  --no-src-dir              Place project files at root instead of src/
  --skip-install            Skip installing dependencies
  --no-git                  Skip git initialization
  -y, --yes                 Skip interactive prompts and use defaults
  -f, --force               Overwrite existing directory
  -h, --help                Show this help message

Examples:
  npm create routecraft@latest my-app
  npm create routecraft@latest my-app --example hello-world --use-pnpm
  npm create routecraft@latest my-app --yes --example hello-world
  npx create-routecraft my-app --force
  npm create routecraft@latest my-app --example https://github.com/user/repo
  npm create routecraft@latest my-app --example https://github.com/user/repo/tree/main/examples/api
`);
}

// Run the CLI
main().catch((error) => {
  console.error("Unexpected error:", error);
  process.exit(1);
});
