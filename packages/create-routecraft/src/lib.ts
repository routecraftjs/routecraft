/* eslint-disable no-console */

import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, realpathSync } from "node:fs";
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
 * Get the version range to pin for @routecraft/* packages in the scaffolded
 * project. The core train is versioned in lockstep (the fixed group in
 * .changeset/config.json), so this package's own version equals the
 * core version. Reading our own package.json keeps the lookup correct both in
 * the monorepo and in a published install; a cross-package relative path would
 * resolve to an unrelated `node_modules/routecraft` after publishing.
 */
export function getRoutecraftVersion(): string {
  try {
    const packagePath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../package.json",
    );
    if (existsSync(packagePath)) {
      const pkg = JSON.parse(readFileSync(packagePath, "utf-8"));
      if (typeof pkg.version === "string" && pkg.version.length > 0) {
        return `^${pkg.version}`;
      }
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
 * Path segments never copied out of an example, whatever its source.
 *
 * Matched per SEGMENT rather than as a substring of the whole relative
 * path. A substring test excludes `.gitignore` and every file under
 * `.github/` along with the repository directory it was aimed at, and
 * excludes a capability folder named `pnpm-lock.yaml-parser` along with the
 * lockfile.
 */
const EXAMPLE_EXCLUDED_DIRECTORIES = new Set(["node_modules", ".git"]);

/**
 * Lockfiles never copied out of an example. A scaffolded project resolves
 * its own dependency tree, and a lockfile pinned against the example's
 * dependency set would either be ignored or, worse, honoured.
 */
const EXAMPLE_EXCLUDED_FILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
]);

/**
 * Whether a path inside an example is one the scaffolder never copies.
 *
 * @param relativePath Path relative to the example root, `""` for the root
 */
export function isExcludedExamplePath(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0) return false;
  if (segments.some((segment) => EXAMPLE_EXCLUDED_DIRECTORIES.has(segment))) {
    return true;
  }
  return EXAMPLE_EXCLUDED_FILES.has(segments[segments.length - 1]!);
}

/**
 * Files an example would place where the base template already wrote one.
 *
 * The built-in example copy lets the base file win, which is silent data
 * loss unless someone says which files went. Walking for the answer up
 * front is what lets the copy name them afterwards.
 *
 * @param sourceDir Example root
 * @param targetDir Project root, already carrying the base template
 * @param exclude Paths the copy will skip anyway, so they are not reported
 * @returns Example-relative paths that already exist in the project
 */
export async function collidingExamplePaths(
  sourceDir: string,
  targetDir: string,
  exclude: (relativePath: string) => boolean = isExcludedExamplePath,
): Promise<string[]> {
  const collisions: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir)) {
      const absolute = join(dir, entry);
      const relativePath = relative(sourceDir, absolute);
      if (exclude(relativePath)) continue;
      if ((await stat(absolute)).isDirectory()) {
        await walk(absolute);
      } else if (existsSync(join(targetDir, relativePath))) {
        collisions.push(relativePath);
      }
    }
  };
  await walk(sourceDir);
  return collisions.sort();
}

/**
 * What a GitHub example URL names.
 */
export interface GitHubExampleRef {
  owner: string;
  repo: string;
  /** Branch to clone. `main` when the URL names none: templates are untagged. */
  branch: string;
  /** Subdirectory inside the repository, or `""` for the whole thing. */
  subPath: string;
}

/**
 * Parse `https://github.com/owner/repo`, optionally `/tree/<branch>` and
 * optionally a subpath under it, with a trailing slash allowed on any of
 * them.
 *
 * The subpath is optional so a whole repository at a named branch is
 * expressible. It was not, which left a template repository unable to
 * scaffold from the branch under test in its own CI.
 *
 * A branch is one path segment. `feature/my-branch` parses as branch
 * `feature` with subpath `my-branch`, because nothing in the URL says which
 * slash is the boundary and resolving it would need a call to GitHub. Use
 * the default branch, or a single-segment one, for URL examples.
 *
 * The subpath is a location inside the clone, so it may not leave it: the
 * directory it names is copied wholesale into the new project, and a `..`
 * segment would copy whatever sits beside the temporary clone instead.
 *
 * @throws Error when the URL is not a GitHub repository URL, or the subpath
 *   escapes the repository
 */
export function parseGitHubExampleUrl(url: string): GitHubExampleRef {
  // A URL copied from the browser carries `?plain=1` or a `#L20` anchor, and
  // neither is part of the path being asked for.
  const match = url
    .replace(/[?#].*$/, "")
    .match(
      /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+?)(?:\/(.+?))?)?\/?$/,
    );
  if (!match) {
    throw new Error(`Invalid GitHub URL format: ${url}`);
  }
  const [, owner, repo, branch = "main", subPath = ""] = match;
  if (subPath.split(/[\\/]/).some((segment) => segment === "..")) {
    throw new Error(
      `Invalid example path "${subPath}": a path inside the repository cannot contain "..".`,
    );
  }
  return { owner: owner!, repo: repo!, branch, subPath };
}

/**
 * Refuse an example directory that is not really inside the clone.
 *
 * Both paths go through `realpath` rather than `resolve`, and only once they
 * exist: `resolve` is lexical, so a repository carrying a symlink passes a
 * string comparison and is then read and copied from wherever the link
 * actually points. Git stores symlinks, so this is reachable from any
 * repository an operator is talked into scaffolding from.
 *
 * The parser refuses `..` already. This is the check that does not depend on
 * the parser being right, because what follows copies this directory
 * wholesale into the user's new project.
 *
 * @param sourceDir Directory the example will be copied from
 * @param tempDir The clone it must stay inside
 * @param subPath The path as the user wrote it, for the message
 * @throws Error when the real path escapes the clone
 */
export function assertInsideRepository(
  sourceDir: string,
  tempDir: string,
  subPath: string,
): void {
  const realSource = realpathSync(sourceDir);
  const realTemp = realpathSync(tempDir);
  if (realSource !== realTemp && !realSource.startsWith(realTemp + sep)) {
    throw new Error(
      `Invalid example path "${subPath}": it resolves outside the repository.`,
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

    const { owner, repo, branch, subPath } = parseGitHubExampleUrl(url);
    const repoUrl = `https://github.com/${owner}/${repo}.git`;

    try {
      const args = ["clone", "--depth", "1"];
      if (branch) {
        args.push("--branch", branch);
      }
      args.push(repoUrl, tempDir);
      execFileSync("git", args, { stdio: "inherit" });
    } catch {
      // A multi-segment branch reaches here rather than the not-found branch
      // below, because the clone is what rejects the guessed branch name.
      // Without this the user is told to check the repository's visibility,
      // which is not the problem.
      const ambiguity = subPath
        ? ` The branch was read as "${branch}" and "${subPath}" as a path inside it; if "${branch}/${subPath}" is one branch name, scaffold from the repository root instead and copy the folder yourself.`
        : "";
      throw new Error(
        `Failed to clone ${repoUrl} at branch "${branch}". Make sure the repository is public and the branch exists.${ambiguity}`,
      );
    }

    const sourceDir = subPath ? join(tempDir, subPath) : tempDir;
    if (!existsSync(sourceDir)) {
      throw new Error(`Path ${subPath} not found in repository`);
    }

    assertInsideRepository(sourceDir, tempDir, subPath);

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
          // The example wins on collision: a URL example is a whole project
          // template, and a base file left standing in the middle of it is a
          // file the template's own CI never saw.
          force: true,
          filter: (src) => !skipFromUrlExample(relative(tempExampleDir, src)),
        });
        // package.json is held back from the copy above and merged instead,
        // because a straight overwrite drops the project name the user just
        // chose and the package manager they picked.
        await mergeExamplePackageJson(tempExampleDir, projectDir);
        await mergeExampleDeps(tempExampleDir, projectDir);
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
        // deps.json is metadata for dependency injection, not project content.
        const skip = (relativePath: string): boolean =>
          relativePath === "deps.json" || isExcludedExamplePath(relativePath);
        const dropped = await collidingExamplePaths(
          exampleDir,
          projectDir,
          skip,
        );
        await cp(exampleDir, projectDir, {
          recursive: true,
          // The base template wins on collision here: its package.json and
          // index.ts carry the placeholders this function already resolved.
          force: false,
          filter: (src) => !skip(relative(exampleDir, src)),
        });

        await mergeExampleDeps(exampleDir, projectDir);

        console.log(`✅ Added ${options.example} example`);
        if (dropped.length > 0) {
          // Named rather than swallowed. `force: false` is silent, so an
          // example file colliding with a base file used to vanish with no
          // trace in a scaffold that looked like it had succeeded.
          console.warn(
            `⚠️  ${dropped.length} file(s) from the ${options.example} example were NOT copied because the base template already wrote them:\n` +
              dropped.map((file) => `   - ${file}`).join("\n"),
          );
        }
      } else {
        throw new Error(`Unknown example: ${options.example}`);
      }
    }
  }

  console.log("Generated project structure");
}

/**
 * Paths a URL example's copy holds back.
 *
 * `package.json` and `deps.json` are merged rather than copied: the first
 * carries the project name and package manager the scaffolder just
 * resolved, and the second is dependency metadata, not project content.
 */
function skipFromUrlExample(relativePath: string): boolean {
  return (
    relativePath === "package.json" ||
    relativePath === "deps.json" ||
    isExcludedExamplePath(relativePath)
  );
}

/**
 * Fields the scaffolded `package.json` keeps whatever the example declares.
 *
 * The project name is what the user typed and `packageManager` is what they
 * picked in the prompt; an example overwriting either replaces a decision
 * with its own placeholder.
 */
const PROJECT_OWNED_PACKAGE_FIELDS = ["name", "packageManager"] as const;

/**
 * Read one of a manifest's string-keyed map fields, refusing anything else.
 *
 * Spreading is forgiving in the wrong direction: `scripts: "run"` spreads to
 * `{ 0: "r", 1: "u", 2: "n" }` and writes a `package.json` no package
 * manager can read, with nothing in the output to say where it came from.
 *
 * A plain object test rather than a schema: this package deliberately ships
 * no runtime dependency, and the question here is one shape, not a contract.
 *
 * @throws Error naming the field and the source when the value is not a map
 */
function mapFieldOrThrow(
  value: unknown,
  field: string,
  source: "example" | "scaffold",
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `The ${source} package.json declares "${field}" as ${Array.isArray(value) ? "an array" : typeof value}, but it must be an object mapping names to strings.`,
    );
  }
  // The values matter as much as the container: a numeric or null entry
  // survives the spread and lands in the generated package.json, where no
  // package manager will accept it.
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new Error(
        `The ${source} package.json declares "${field}.${name}" as ${entry === null ? "null" : typeof entry}, but every entry must be a string.`,
      );
    }
  }
  return value as Record<string, string>;
}

/**
 * Merge a URL example's `package.json` into the scaffolded one.
 *
 * The example wins on every field it declares (its scripts, its engines,
 * its dependency ranges: it is a whole project template and its CI ran
 * against exactly those), except the two fields that belong to this
 * scaffold rather than to the template. The three dependency maps and
 * `scripts` merge key by key instead of being replaced, so the base's
 * `@routecraft/cli` devDependency survives a template that only declares
 * its own additions.
 *
 * A URL example with no `package.json` is left alone: it is an example
 * fragment rather than a project template, and the base manifest already
 * describes the project.
 */
export async function mergeExamplePackageJson(
  exampleDir: string,
  projectDir: string,
): Promise<void> {
  const examplePath = join(exampleDir, "package.json");
  if (!existsSync(examplePath)) return;

  const example = JSON.parse(await readFile(examplePath, "utf-8")) as Record<
    string,
    unknown
  >;
  const pkgPath = join(projectDir, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf-8")) as Record<
    string,
    unknown
  >;

  const merged: Record<string, unknown> = { ...pkg, ...example };
  for (const field of PROJECT_OWNED_PACKAGE_FIELDS) {
    if (pkg[field] !== undefined) merged[field] = pkg[field];
  }
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "scripts",
  ] as const) {
    const base = mapFieldOrThrow(pkg[field], field, "scaffold");
    const overlay = mapFieldOrThrow(example[field], field, "example");
    if (base === undefined && overlay === undefined) continue;
    merged[field] = { ...base, ...overlay };
  }

  await writeFile(pkgPath, JSON.stringify(merged, null, 2) + "\n");
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
