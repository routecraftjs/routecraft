import type { CraftConfig } from "./context.ts";
import type { CredentialStore } from "./plugins/credentials/types.ts";

/**
 * What a project command is run with: the project it was run in, and the
 * resources the CLI can open for it.
 */
export interface ProjectCommandIO {
  /** The command's arguments, after its name. */
  readonly args: readonly string[];
  /** The project directory. */
  readonly root: string;
  /**
   * Opens the project's credential store, the way the application opens
   * it. Called only by a command that needs one. The CLI closes a store it
   * opened, and leaves one the configuration supplies to its owner.
   */
  credentials(): Promise<CredentialStore>;
}

/** What a project command leaves the CLI to print and exit with. */
export interface ProjectCommandResult {
  readonly code: number;
  /** Written to standard output. */
  readonly output?: string;
  /** Written to standard error. */
  readonly error?: string;
}

/**
 * A command an ecosystem package contributes to the `craft` CLI, run
 * against the project's loaded configuration. The package owns what it
 * does and what it prints, so the CLI runs it without knowing the
 * protocol behind it or depending on the package.
 */
export type ProjectCommand = (
  config: CraftConfig,
  io: ProjectCommandIO,
) => Promise<ProjectCommandResult>;

/** Shared across copies of the package, like the credential-login registry. */
const REGISTRY_KEY: unique symbol = Symbol.for("routecraft.project-commands");

type GlobalWithRegistry = typeof globalThis & {
  [REGISTRY_KEY]?: Map<string, ProjectCommand>;
};

function registry(): Map<string, ProjectCommand> {
  const g = globalThis as GlobalWithRegistry;
  g[REGISTRY_KEY] ??= new Map();
  return g[REGISTRY_KEY];
}

/**
 * Contribute a command to the `craft` CLI under `name`, the words it is
 * typed as (`"mcp pin"`). Called once at module load, beside the package's
 * config applier; a second copy of the package replaces the entry.
 */
export function registerProjectCommand(
  name: string,
  command: ProjectCommand,
): void {
  registry().set(name, command);
}

/** The command registered under `name`, when a loaded package provides one. */
export function projectCommand(name: string): ProjectCommand | undefined {
  return registry().get(name);
}
