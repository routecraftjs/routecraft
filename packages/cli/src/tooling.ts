import type {
  CraftConfig,
  CredentialStore,
  InstalledTooling,
  ToolingCommand,
} from "@routecraft/routecraft";
import type { ExecResult } from "./exec.js";
import { loadProjectConfig } from "./project-config.js";
import { messageOf } from "./util.js";

/**
 * The verbs `craft` keeps for itself. No plugin's commands live under one:
 * a plugin whose namespace equals one and that declares commands is refused
 * (`RC1117`).
 */
export const RESERVED_VERBS: readonly string[] = [
  "run",
  "start",
  "exec",
  "connect",
  "disconnect",
  "tui",
  "help",
];

/**
 * The verbs `craft` shares with the first-party plugin of the same
 * namespace, each with the subcommands `craft` ships under it. The plugin
 * adds more through `tooling.commands`; a key equal to a shipped subcommand
 * is refused (`RC1117`).
 */
export const SHARED_VERBS: Readonly<Record<string, readonly string[]>> = {
  mcp: [],
  acp: [],
  ops: ["health", "ready", "routes", "deferrals", "indicators"],
};

/** Root and per-command options that take a value, skipped when reading the verb. */
const VALUED_FLAGS: readonly string[] = [
  "--log-level",
  "--log-file",
  "--env",
  "--profile",
];

/**
 * The verb of a command line and the word after it, read past the flags
 * `craft` itself takes. A flag `craft` does not know ends the reading: what
 * follows it may be that flag's value, so it is never taken for a command.
 */
function operands(argv: readonly string[]): string[] | undefined {
  const out: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith("-")) {
      out.push(arg);
      if (out.length === 2) return out;
      continue;
    }
    if (VALUED_FLAGS.includes(arg)) {
      index += 1;
      continue;
    }
    if (VALUED_FLAGS.some((flag) => arg.startsWith(`${flag}=`))) continue;
    // Ahead of the verb it is craft's own (--help, --version).
    return out.length === 0 ? undefined : out;
  }
  return out;
}

/**
 * Whether a command line names a plugin's command rather than one `craft`
 * ships, decided from the words alone so it can be known before the project
 * is loaded.
 *
 * @param argv - The command line after `craft`
 * @param hasProject - Whether the working directory holds a `craft.config.*`
 * @returns The plugin namespace and command key (no key lists the plugin's
 *   commands), or `undefined` when the line is `craft`'s own
 */
export function toolingInvocation(
  argv: readonly string[],
  hasProject: boolean,
): { namespace: string; key?: string } | undefined {
  const words = operands(argv);
  const namespace = words?.[0];
  if (namespace === undefined || RESERVED_VERBS.includes(namespace)) {
    return undefined;
  }
  const key = words?.[1];
  const shipped = Object.hasOwn(SHARED_VERBS, namespace)
    ? SHARED_VERBS[namespace]
    : undefined;
  if (shipped === undefined) {
    // An unknown word outside a project stays commander's to refuse.
    if (!hasProject) return undefined;
    return key === undefined ? { namespace } : { namespace, key };
  }
  if (key === undefined) {
    // A shared verb with nothing shipped under it is the plugin's alone.
    return shipped.length === 0 && namespace !== "acp"
      ? { namespace }
      : undefined;
  }
  return shipped.includes(key) ? undefined : { namespace, key };
}

/**
 * Refuse a plugin whose commands could never be reached: under a verb
 * `craft` keeps, or under the name of a subcommand `craft` ships.
 *
 * Checked here and not by the kernel, which learns no verb of the command
 * line.
 *
 * @throws RC1117 naming the plugin and the collision
 */
export async function assertVerbTable(
  tooling: readonly InstalledTooling[],
): Promise<void> {
  const { rcError } = await import("@routecraft/routecraft");
  for (const { plugin, namespace, commands } of tooling) {
    const keys = Object.keys(commands);
    if (keys.length === 0) continue;
    if (RESERVED_VERBS.includes(namespace)) {
      throw rcError("RC1117", undefined, {
        message: `Invalid plugin "${plugin}": it declares tooling commands under the namespace "${namespace}", which is craft's own verb. Give the plugin an explicit namespace.`,
      });
    }
    const shipped = Object.hasOwn(SHARED_VERBS, namespace)
      ? SHARED_VERBS[namespace]!
      : [];
    const taken = keys.find((key) => shipped.includes(key));
    if (taken !== undefined) {
      throw rcError("RC1117", undefined, {
        message: `Invalid plugin "${plugin}": its tooling command "${taken}" duplicates craft ${namespace} ${taken}, which craft ships. Rename the command.`,
      });
    }
  }
}

/**
 * The tooling of every plugin a configuration installs, with the verb table
 * checked.
 *
 * @throws RC1117 from {@link assertVerbTable}, and whatever resolving the
 *   plugin list raises
 */
export async function toolingOf(
  config: CraftConfig,
): Promise<InstalledTooling[]> {
  const { pluginTooling } = await import("@routecraft/routecraft");
  const tooling = pluginTooling(config);
  await assertVerbTable(tooling);
  return tooling;
}

function listing(tooling: readonly InstalledTooling[]): string {
  const lines = tooling.flatMap(({ namespace, commands }) =>
    Object.entries(commands).map(([key, command]) =>
      describeCommand(namespace, key, command),
    ),
  );
  return lines.length === 0
    ? "No installed plugin declares a command."
    : `Plugin commands in this project:\n${lines.join("\n")}`;
}

function describeCommand(
  namespace: string,
  key: string,
  command: ToolingCommand,
): string {
  const usage = command.usage === undefined ? "" : ` ${command.usage}`;
  return `  craft ${namespace} ${key}${usage}  ${command.summary}`;
}

/**
 * Run `craft <namespace> <key>`: a command the plugin with that namespace
 * declares in `tooling.commands`. The plugin owns what the command does and
 * prints; this loads the project, hands the command its own credentials and
 * closes the store if the command opened it.
 *
 * @param namespace - The plugin's namespace
 * @param key - The command; `undefined` lists the namespace's commands
 * @param args - The command line after the command's name
 */
export async function runToolingCommand(
  namespace: string,
  key: string | undefined,
  args: readonly string[],
): Promise<ExecResult> {
  let opening: Promise<{ store: CredentialStore; owned: boolean }> | undefined;
  try {
    const { root, config } = await loadProjectConfig(
      `craft ${namespace}`,
      "the plugins whose commands it runs",
    );
    const core = await import("@routecraft/routecraft");
    const tooling = await toolingOf(config);
    const owner = tooling.find(
      (each) =>
        each.namespace === namespace && Object.keys(each.commands).length > 0,
    );
    if (owner === undefined) {
      return {
        code: 1,
        error: `"${namespace}" is not a craft command, and no installed plugin declares commands under that namespace. ${listing(tooling)}`,
      };
    }
    const wantsHelp = args.includes("--help") || args.includes("-h");
    if (key === undefined) {
      return { code: wantsHelp ? 0 : 1, output: listing([owner]) };
    }
    const command = Object.hasOwn(owner.commands, key)
      ? owner.commands[key]
      : undefined;
    if (command === undefined) {
      return {
        code: 1,
        error: `Plugin "${owner.plugin}" declares no command "${key}". ${listing([owner])}`,
      };
    }
    if (wantsHelp) {
      return {
        code: 0,
        output: `Usage: craft ${namespace} ${key}${command.usage === undefined ? "" : ` ${command.usage}`}\n\n${command.summary}`,
      };
    }
    const owners = new Set(owner.logins.map((login) => login.owner));
    return await command.run(args, {
      root,
      logger: config.logger ?? core.defaultLogger(),
      credentials: async () => {
        opening ??= core.openCredentialStore(core.credentialsConfigOf(config));
        return core.scopedCredentialStore(
          (await opening).store,
          owners,
          owner.plugin,
        );
      },
    });
  } catch (error: unknown) {
    return { code: 1, error: messageOf(error) };
  } finally {
    const opened = await opening?.catch(() => undefined);
    if (opened?.owned) await opened.store.close();
  }
}
