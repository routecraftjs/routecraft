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
 * Get the current version of @routecraftjs/routecraft from package.json
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
 * Default project structure template for Node.js package managers
 */
const NODE_TEMPLATE = {
  "package.json": {
    content: (projectName: string) =>
      JSON.stringify(
        {
          name: projectName,
          version: "0.1.0",
          private: true,
          type: "module",
          scripts: {
            dev: "craft dev",
            build: "craft build",
            start: "craft start",
          },
          dependencies: {
            "@routecraftjs/routecraft": getRoutecraftVersion(),
          },
          devDependencies: {
            "@types/node": "^20.0.0",
            typescript: "^5.0.0",
          },
        },
        null,
        2,
      ),
  },
  "tsconfig.json": {
    content: JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          allowSyntheticDefaultImports: true,
          esModuleInterop: true,
          allowJs: true,
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          isolatedModules: true,
          resolveJsonModule: true,
        },
        include: ["**/*.ts", "**/*.js"],
        exclude: ["node_modules"],
      },
      null,
      2,
    ),
  },
  "craft.config.ts": {
    content: `import type { CraftConfig } from "@routecraftjs/routecraft";

const config: CraftConfig = {
  routes: [], // Add your routes here
};

export default config;`,
  },
  ".gitignore": {
    content: `node_modules/
dist/
.env
.env.local
.env.*.local
*.log
.DS_Store`,
  },
};

/**
 * Example route templates for Node.js
 */
const EXAMPLES = {
  "hello-world": {
    "routes/hello-world.route.ts": {
      content: `import { log, craft, simple, fetch } from "@routecraftjs/routecraft";

export default craft()
  .id("hello-world")
  .from(simple({ userId: 1 }))
  .enrich(
    fetch({
      method: "GET",
      url: (ex) =>
        \`https://jsonplaceholder.typicode.com/users/\${ex.body.userId}\`,
    }),
  )
  .transform((res) => JSON.parse(res.body))
  .transform((user) => \`Hello, \${user.name}!\`)
  .to(log());
`,
    },
  },
};

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
  ${answers.skipInstall ? `${getPackageManagerCommand(answers.packageManager)} install` : ""}
  ${getPackageManagerCommand(answers.packageManager)} run dev

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
        ? "hello-world"
        : await input({
            message: "Example (optional):",
            default: "none",
            validate: (value: string) => {
              if (value === "none") return true;
              if (isUrl(value)) return true;
              const validExamples = ["hello-world"];
              if (validExamples.includes(value)) return true;
              return `Must be "none", a built-in example (${validExamples.join(", ")}), or a GitHub URL`;
            },
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

  // Create base directories
  await mkdir(join(baseDir, "routes"), { recursive: true });
  await mkdir(join(baseDir, "adapters"), { recursive: true });
  await mkdir(join(baseDir, "plugins"), { recursive: true });

  // Generate template files
  const template = NODE_TEMPLATE;
  for (const [filePath, fileConfig] of Object.entries(template)) {
    const fullPath = join(projectDir, filePath);
    await mkdir(dirname(fullPath), { recursive: true });

    const content =
      typeof fileConfig.content === "function"
        ? fileConfig.content(options.projectName)
        : fileConfig.content;

    await writeFile(fullPath, content);
    console.log(`Created file: ${filePath}`);
  }

  // Add example routes if requested
  if (options.example !== "none") {
    if (isUrl(options.example)) {
      // Handle GitHub URL examples
      const tempExampleDir = await downloadGitHubExample(options.example);
      try {
        // Copy all files from the downloaded example to the routes directory
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
      // Handle built-in examples
      const examples = EXAMPLES;
      const example = examples[options.example as keyof typeof examples];
      if (!example) {
        throw new Error(`Unknown example: ${options.example}`);
      }
      for (const [filePath, fileConfig] of Object.entries(example)) {
        const fullPath = join(baseDir, filePath);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, fileConfig.content);
        console.log(`Created example file: ${filePath}`);
      }
    }
  }

  // Update package.json scripts if using src directory
  if (options.useSrcDir) {
    const packageJsonPath = join(projectDir, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf-8"));
    packageJson.scripts = {
      ...packageJson.scripts,
      dev: "craft dev --src",
      build: "craft build --src",
      start: "craft start --src",
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
