/* eslint-disable no-console */

import { mkdir, writeFile, readFile, readdir, lstat } from "node:fs/promises";
import { join, resolve, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
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
 * Substitute a template's placeholders.
 *
 * Longest key first, because one placeholder can be a prefix of another:
 * replacing `PACKAGE_MANAGER` before `PACKAGE_MANAGER_RUN` leaves
 * `bun@1.3.9_RUN` in the file, which is not an error anywhere, just wrong
 * output in a README nobody re-reads. Object key order would otherwise
 * decide the result.
 */
export function processTemplate(
  content: string,
  replacements: Record<string, string>,
): string {
  let processed = content;
  const keys = Object.keys(replacements).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    processed = processed.replaceAll(key, replacements[key]!);
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
    // Symlinks are not counted, because the copy skips them. Counting one
    // would accept an example whose only project markers are links and then
    // scaffold nothing but the base template, reporting success.
    const files = (await readdir(sourceDir)).filter(
      (file) => !isSymbolicLink(join(sourceDir, file)),
    );

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
      const fileStat = await lstat(filePath);
      if (fileStat.isDirectory()) {
        const subFiles = (await readdir(filePath)).filter(
          (f) => !isSymbolicLink(join(filePath, f)),
        );
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
  if (isExcludedPrefix(segments)) return true;
  return EXAMPLE_EXCLUDED_FILES.has(segments[segments.length - 1]!);
}

/**
 * Path prefixes never copied out of an example.
 *
 * A prefix rather than a bare segment name, because the thing being excluded
 * is a specific location and not a word: an example may legitimately carry a
 * capability folder called `workflows/`, and a bare segment test would drop
 * that too.
 */
const EXAMPLE_EXCLUDED_PREFIXES: readonly (readonly string[])[] = [
  [".github", "workflows"],
];

/**
 * Whether a path sits under one of {@link EXAMPLE_EXCLUDED_PREFIXES}.
 *
 * The template's CI is about the template's repository: it tests the
 * example against its own branches and its own secrets, and none of that is
 * true in the project being scaffolded. A workflow copied there either fails
 * on the first push or, worse, is guarded into never running and sits in
 * somebody's repository forever as config they did not write.
 */
function isExcludedPrefix(segments: readonly string[]): boolean {
  return EXAMPLE_EXCLUDED_PREFIXES.some(
    (prefix) =>
      segments.length >= prefix.length &&
      prefix.every((segment, index) => segments[index] === segment),
  );
}

/**
 * What a GitHub example URL names.
 */
export interface GitHubExampleRef {
  owner: string;
  repo: string;
  /**
   * Everything after `/tree/`, unsplit, and `""` when the URL names nothing.
   *
   * Unsplit on purpose. A ref name may contain `/`, so nothing in the URL
   * says which slash divides the ref from the path inside it. The remote
   * does, and {@link resolveExampleRef} asks it.
   */
  remainder: string;
}

/** Where a `/tree/...` remainder actually points, once the remote has said. */
export interface ResolvedExampleRef {
  /** The ref to clone, or `undefined` for the repository's default branch. */
  ref: string | undefined;
  /** Subdirectory inside the repository, or `""` for the whole thing. */
  subPath: string;
}

/** A remote's ref names, without their `refs/heads/` or `refs/tags/` prefix. */
export interface RemoteRefs {
  heads: readonly string[];
  tags: readonly string[];
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
      /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/(.+?))?\/?$/,
    );
  if (!match) {
    throw new Error(`Invalid GitHub URL format: ${url}`);
  }
  const [, owner, repo, remainder = ""] = match;
  // Checked here rather than after the split, so it catches a climb whichever
  // side of the boundary it lands on. A ref named `..` is invalid in git
  // anyway, so nothing legitimate is refused by testing the whole remainder.
  if (remainder.split(/[\\/]/).some((segment) => segment === "..")) {
    throw new Error(
      `Invalid example path "${remainder}": a path inside the repository cannot contain "..".`,
    );
  }
  return { owner: owner!, repo: repo!, remainder };
}

/**
 * Split a `/tree/...` remainder into the ref it names and the path inside it.
 *
 * Exact rather than a heuristic, and the reason is how git stores refs. They
 * are a directory tree, so `refs/heads/claude` and `refs/heads/claude/foo`
 * cannot both exist: git refuses the second with "cannot lock ref". At most
 * one ref can therefore be a prefix of any given remainder, so taking the
 * longest match resolves the URL rather than guessing at it, and there is no
 * ambiguity left for a flag to settle.
 *
 * This is what GitHub itself does when it renders a `/tree/` URL, and it is
 * why a branch named `feature/login` is expressible here at all. It used to
 * be read as branch `feature` with `login` as a path inside it, which broke
 * every `feat/*`, `fix/*` and `claude/*` branch.
 *
 * Branches are searched before tags at the same length. The two namespaces
 * are separate, so a name can be both, and a branch is what a `/tree/` URL
 * means when a browser produces one.
 *
 * @throws Error naming the refs that do exist, which is the question a miss
 *   actually raises
 */
export function resolveExampleRef(
  remainder: string,
  refs: RemoteRefs,
): ResolvedExampleRef {
  if (remainder === "") return { ref: undefined, subPath: "" };

  const segments = remainder.split("/").filter(Boolean);
  const heads = new Set(refs.heads);
  const tags = new Set(refs.tags);
  for (let take = segments.length; take > 0; take--) {
    const candidate = segments.slice(0, take).join("/");
    if (heads.has(candidate) || tags.has(candidate)) {
      return { ref: candidate, subPath: segments.slice(take).join("/") };
    }
  }

  throw new Error(
    `No branch or tag matches "${remainder}".\n` +
      `${describeRefs("Branches", refs.heads)}\n` +
      `${describeRefs("Tags", refs.tags)}`,
  );
}

/** How many ref names a miss lists before it starts counting instead. */
const REFS_NAMED_ON_A_MISS = 20;

/**
 * Name the refs a miss could have meant, bounded. A repository with six
 * hundred branches would otherwise answer a typo with six hundred lines.
 */
function describeRefs(label: string, names: readonly string[]): string {
  if (names.length === 0) return `${label}: none`;
  const shown = names.slice(0, REFS_NAMED_ON_A_MISS).join(", ");
  const rest = names.length - REFS_NAMED_ON_A_MISS;
  return rest > 0
    ? `${label}: ${shown}, and ${rest} more`
    : `${label}: ${shown}`;
}

/**
 * Ask the remote which refs it has.
 *
 * Unauthenticated, no API token and no rate limit, over the same transport
 * as the clone on the next line. It adds one round trip to a path that
 * already makes one, so an offline or firewalled run fails a step earlier
 * and with a clearer message than a clone would give.
 */
async function listRemoteRefs(repoUrl: string): Promise<RemoteRefs> {
  const output = execFileSync(
    "git",
    ["ls-remote", "--heads", "--tags", repoUrl],
    {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const heads: string[] = [];
  const tags: string[] = [];
  for (const line of output.split("\n")) {
    const ref = line.split("\t")[1];
    if (ref === undefined) continue;
    // `refs/tags/v1^{}` is the peeled object of an annotated tag, the same
    // name a second time. Cloning by name works either way, so the marker is
    // dropped rather than offered as a separate ref.
    if (ref.endsWith("^{}")) continue;
    if (ref.startsWith("refs/heads/"))
      heads.push(ref.slice("refs/heads/".length));
    else if (ref.startsWith("refs/tags/"))
      tags.push(ref.slice("refs/tags/".length));
  }
  return { heads, tags };
}

/**
 * Whether a path is a symlink.
 *
 * The containment check covers the example's root. It cannot cover what is
 * under it: `cp` preserves symlinks rather than following them, so a link
 * anywhere in the tree lands in the generated project still pointing at the
 * author's machine, and a `package.json` that is itself a link is read from
 * wherever it points. Both are refused by skipping every link, which costs
 * an example nothing real: a scaffold is a fresh checkout, and a link into
 * it would be broken the moment it was copied anyway.
 */
export function isSymbolicLink(candidate: string): boolean {
  try {
    return lstatSync(candidate).isSymbolicLink();
  } catch {
    return false;
  }
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

    const { owner, repo, remainder } = parseGitHubExampleUrl(url);
    const repoUrl = `https://github.com/${owner}/${repo}.git`;

    // The remote is asked which refs exist before the clone, because the URL
    // alone cannot say where the ref ends and the path begins.
    const { ref, subPath } = resolveExampleRef(
      remainder,
      await listRemoteRefs(repoUrl),
    );

    try {
      const args = ["clone", "--depth", "1"];
      if (ref !== undefined) {
        args.push("--branch", ref);
      }
      args.push(repoUrl, tempDir);
      execFileSync("git", args, { stdio: "inherit" });
    } catch {
      throw new Error(
        `Failed to clone ${repoUrl}${ref === undefined ? "" : ` at "${ref}"`}. Make sure the repository is public.`,
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

    // "" is the built-in template. There is one, so the only question left
    // is whether to start from it or from somebody's repository, and the
    // default answer is the template.
    example:
      (options["example"] as ExampleType) ||
      (skipPrompts
        ? ""
        : await select<string>({
            message: "Start from:",
            choices: [
              { name: "The starter template", value: "" },
              { name: "A GitHub repository", value: "custom-url" },
            ],
            default: "",
          }).then(async (choice) => {
            if (choice === "custom-url") {
              return await input({
                message:
                  "GitHub URL (e.g. https://github.com/routecraftjs/craft-harness):",
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
 * Files copied out of the template verbatim, mapped to the name they take in
 * a project. `gitignore` is stored without its dot because npm refuses to
 * publish a `.gitignore` inside a package.
 */
const TEMPLATE_FILES: Record<string, string> = {
  gitignore: ".gitignore",
  ".prettierrc": ".prettierrc",
  "craft.config.ts": "craft.config.ts",
  "eslint.config.mjs": "eslint.config.mjs",
  "tsconfig.json": "tsconfig.json",
};

/**
 * Write the template into the project directory.
 *
 * One template, laid out for the folder convention: `craft start` discovers
 * `capabilities/` from disk, so a project has no entry file listing its
 * routes and nothing to register by hand.
 *
 * `adapters/` and `plugins/` are not created. An empty directory is not a
 * thing git can carry, so scaffolding them produced folders that vanished on
 * the author's first commit; the README names the convention instead, which
 * survives.
 */
export async function generateProjectStructure(
  projectDir: string,
  options: Required<InitOptions>,
) {
  const fromUrlExample = isUrl(options.example);
  const replacements = {
    PROJECT_NAME: options.projectName,
    ROUTECRAFT_VERSION: getRoutecraftVersion(),
    PACKAGE_MANAGER: getPackageManagerVersion(options.packageManager),
    PACKAGE_MANAGER_RUN: `${getPackageManagerCommand(options.packageManager)} run`,
  };

  for (const [sourceFile, destFile] of Object.entries(TEMPLATE_FILES)) {
    const content = await readFile(
      join(TEMPLATES_DIR, "base", sourceFile),
      "utf-8",
    );
    await writeFile(join(projectDir, destFile), content);
    console.log(`Created file: ${destFile}`);
  }

  // package.json and README.md carry placeholders the caller's answers
  // resolve: the project name, the package manager, and the version of the
  // routecraft train this scaffolder belongs to.
  const packageJson = processTemplate(
    await readFile(join(TEMPLATES_DIR, "base", "package.json"), "utf-8"),
    replacements,
  );
  await writeFile(join(projectDir, "package.json"), packageJson);
  console.log("Created file: package.json");

  // A URL example is a whole project rather than an addition to one, so the
  // sample capability must not be left standing inside it and a README
  // describing `hello-world` must not sit at its root.
  if (!fromUrlExample) {
    const readme = processTemplate(
      await readFile(join(TEMPLATES_DIR, "base", "README.md"), "utf-8"),
      replacements,
    );
    await writeFile(join(projectDir, "README.md"), readme);
    console.log("Created file: README.md");

    await cp(
      join(TEMPLATES_DIR, "base", "capabilities"),
      join(projectDir, "capabilities"),
      { recursive: true },
    );
    console.log("Created directory: capabilities/hello-world");
  }

  if (fromUrlExample) {
    const tempExampleDir = await downloadGitHubExample(options.example);
    try {
      await cp(tempExampleDir, projectDir, {
        recursive: true,
        // The example wins on collision: a URL example is a whole project
        // template, and a base file left standing in the middle of it is a
        // file the template's own CI never saw.
        force: true,
        filter: (src) =>
          !isSymbolicLink(src) &&
          !skipFromUrlExample(relative(tempExampleDir, src)),
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
  if (!existsSync(examplePath) || isSymbolicLink(examplePath)) return;

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
  ] as const) {
    const base = mapFieldOrThrow(pkg[field], field, "scaffold");
    const overlay = mapFieldOrThrow(example[field], field, "example");
    if (base === undefined && overlay === undefined) continue;
    merged[field] = pinRoutecraftVersions({ ...base, ...overlay });
  }
  {
    const base = mapFieldOrThrow(pkg["scripts"], "scripts", "scaffold");
    const overlay = mapFieldOrThrow(example["scripts"], "scripts", "example");
    if (base !== undefined || overlay !== undefined) {
      merged["scripts"] = { ...base, ...overlay };
    }
  }

  await writeFile(pkgPath, JSON.stringify(merged, null, 2) + "\n");
}

/**
 * Give every `@routecraft/*` entry the version this scaffolder belongs to.
 *
 * An example repository describes a project's shape. It does not decide
 * which version of the framework the person scaffolding is entitled to, and
 * letting it pin one produced two failures at once: asking for `@canary` and
 * getting whatever the example last committed, and a tree whose packages
 * came from different builds of a train the changeset config versions in
 * lockstep. `@routecraft/os` sat eight days behind the rest that way.
 *
 * The pinned value is replaced rather than warned about, because a warning
 * nobody reads still leaves the wrong tree installed. Everything that is not
 * `@routecraft/*` is the example's to choose and is left alone.
 */
function pinRoutecraftVersions(
  deps: Record<string, string>,
): Record<string, string> {
  const version = getRoutecraftVersion();
  const pinned: Record<string, string> = {};
  for (const [name, range] of Object.entries(deps)) {
    pinned[name] = name.startsWith("@routecraft/") ? version : range;
  }
  return pinned;
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
  if (!existsSync(depsPath) || isSymbolicLink(depsPath)) return;

  const exampleDeps = JSON.parse(await readFile(depsPath, "utf-8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  const pkgPath = join(projectDir, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));

  if (exampleDeps.dependencies) {
    pkg.dependencies = pinRoutecraftVersions({
      ...pkg.dependencies,
      ...exampleDeps.dependencies,
    });
  }
  if (exampleDeps.devDependencies) {
    pkg.devDependencies = pinRoutecraftVersions({
      ...pkg.devDependencies,
      ...exampleDeps.devDependencies,
    });
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
  -e, --example <url>       Start from a GitHub repository instead of the
                            starter template
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
  bunx create-routecraft my-app --yes --use-bun
  bunx create-routecraft my-app --force
  bunx create-routecraft my-agent --example https://github.com/routecraftjs/craft-harness
  bunx create-routecraft my-app --example https://github.com/user/repo/tree/main/examples/api
`);
}
