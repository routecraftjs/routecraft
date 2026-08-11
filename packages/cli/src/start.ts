import { join, resolve } from "node:path";
import {
  ContextBuilder,
  getProjectDiscoverers,
  isRouteBuilder,
  isRouteDefinition,
  logger,
  mergeProjectConfig,
  shutdownHandler,
  RUNNER_ARGV,
  type CraftConfig,
  type CraftContext,
  type CraftPlugin,
  type AnyRouteBuilder,
  type RouteDefinition,
} from "@routecraft/routecraft";
import { collectRoutes, type RunResult } from "./run.js";
import { messageOf } from "./util.js";
import {
  CONFIG_STEM,
  discoverCapabilityModules,
  discoverPluginModules,
  displayPath,
  findConfigFile,
  isDirectory,
  isPluginInstance,
} from "./project.js";

/**
 * Folders `craft start` discovers. `capabilities` and `plugins` are
 * loaded by the CLI itself; the rest carry meaning the CLI does not
 * have and are handed to a registered project discoverer.
 */
const CAPABILITIES_FOLDER = "capabilities";
const PLUGINS_FOLDER = "plugins";

/**
 * Convention folders whose contents only an ecosystem package can
 * interpret. Present on disk with no discoverer registered is an
 * error, never a silent skip: the symptom would be an agent that is
 * merely absent.
 */
const DISCOVERED_FOLDERS = ["skills", "agents"];

/** Every folder the convention knows, used to pick the content root. */
const CONVENTION_FOLDERS = [
  CAPABILITIES_FOLDER,
  PLUGINS_FOLDER,
  ...DISCOVERED_FOLDERS,
];

/** Options accepted by {@link startCommand}. */
export interface StartOptions {
  /**
   * Shut down cleanly once the first exchange reaches a terminal
   * outcome on any route. For CI smoke checks and one-shot runs.
   */
  once?: boolean;
  /**
   * Give up after this many milliseconds and exit non-zero. Without it
   * a project whose sources never produce an exchange waits forever,
   * which for a CI gate reports as a job timeout rather than as a
   * diagnosis.
   */
  timeoutMs?: number;
}

/**
 * Boot a whole project from the folder convention.
 *
 * Where `craft run` executes one entry file, `start` reads
 * `craft.config.ts` and then discovers what the project declares on
 * disk: capabilities, plugins, and any folder an ecosystem package has
 * claimed through `registerProjectDiscoverer` (`agents/` and `skills/`
 * come from `@routecraft/ai`).
 *
 * Code wins and convention fills the gaps. Anything declared in
 * `craft.config.ts` is left alone; discovery adds what the config did
 * not. Every discovered agent is logged with the file it came from, so
 * precedence is visible in a startup log rather than inferred.
 *
 * @param dir - Project root, defaulting to the current directory
 * @param options - Runtime flags
 */
export async function startCommand(
  dir: string | undefined,
  options: StartOptions = {},
): Promise<RunResult> {
  const root = resolve(process.cwd(), dir ?? ".");
  if (!isDirectory(root)) {
    return fail(`Project directory "${root}" does not exist.`);
  }

  const configPath = findConfigFile(root);
  if (configPath === undefined) {
    return fail(
      `No ${CONFIG_STEM}.ts found in "${root}". A project needs one at its root: it is what pulls plugins and ecosystem packages into the module graph. Create it with \`export const craftConfig = defineConfig({ ... })\`, or run a single file with \`craft run <file>\`.`,
    );
  }

  let config: CraftConfig;
  try {
    config = await loadConfig(configPath);
  } catch (error: unknown) {
    return fail(
      `Failed to load ${displayPath(root, configPath)}: ${messageOf(error)}`,
    );
  }

  const contentRoot = pickContentRoot(root);
  logger.info(`Starting project "${root}" (content root: "${contentRoot}").`);

  try {
    const pluginsDir = join(contentRoot, PLUGINS_FOLDER);
    if (isDirectory(pluginsDir)) {
      config = mergeProjectConfig(config, {
        plugins: await loadPlugins(root, pluginsDir),
      });
    }

    config = await applyDiscoverers(root, contentRoot, config);

    const builder = new ContextBuilder().with(config);

    const capabilitiesDir = join(contentRoot, CAPABILITIES_FOLDER);
    if (isDirectory(capabilitiesDir)) {
      for (const route of await loadCapabilities(root, capabilitiesDir)) {
        builder.routes(route);
      }
    }

    const { context } = await builder.build();
    // `start` has no trailing-argument passthrough the way `run` does,
    // so the key is present and empty rather than absent.
    context.setStore(RUNNER_ARGV, []);
    shutdownHandler(context);

    // `context.start()` deliberately never resolves while a server
    // ingress is held open (see Route.start), so `--once` has to race
    // it rather than await it: awaiting first would mean the flag only
    // worked on projects that were going to exit anyway.
    const started = context.start();
    if (!options.once) {
      await started;
      return { success: true };
    }

    const timeout = options.timeoutMs;
    const outcome = await Promise.race([
      watchFirstExchange(context),
      // Every route finished on its own before any exchange landed.
      started.then(() => "drained" as const),
      ...(timeout === undefined ? [] : [expire(timeout)]),
    ]);

    if (outcome === "drained") {
      await started;
      return { success: true };
    }
    if (outcome === "timeout") {
      await context.stop();
      return fail(
        `No exchange reached a terminal outcome within ${String(timeout)}ms. Nothing in this project produced one; check that a source actually fires, or raise --timeout.`,
      );
    }
    logger.info(`Exchange ${outcome}; shutting down (--once).`);
    await context.stop();
    // Attach the start rejection so a route failure during shutdown is
    // reported rather than surfacing as an unhandled rejection.
    await started.catch(() => undefined);
    return outcome === "failed"
      ? fail("The first exchange failed. See the logged error for the cause.")
      : { success: true };
  } catch (error: unknown) {
    return fail(messageOf(error));
  }
}

/**
 * Read the project configuration from its module. The named
 * `craftConfig` export is the shape the runtime and the scaffolder
 * both use; a default export is accepted with a warning so the form
 * that older docs showed is not a silent failure.
 */
async function loadConfig(configPath: string): Promise<CraftConfig> {
  const module = (await import(configPath)) as {
    craftConfig?: CraftConfig;
    default?: unknown;
  };
  if (module.craftConfig !== undefined) return module.craftConfig;
  if (isConfigObject(module.default)) {
    logger.warn(
      `${configPath}: found a default export but no "craftConfig" export. Rename it to \`export const craftConfig = defineConfig({ ... })\`; the default export is read for compatibility only.`,
    );
    return module.default;
  }
  throw new Error(
    `exports neither "craftConfig" nor a config object as default. Add \`export const craftConfig = defineConfig({ ... })\`; without it no plugin or ecosystem package this project needs is in the module graph.`,
  );
}

function isConfigObject(value: unknown): value is CraftConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    // Brand guards rather than duck-typing `build`: a route default
    // export is the realistic mistake here, and core already exports
    // the means to recognise one.
    !isRouteBuilder(value) &&
    !isRouteDefinition(value)
  );
}

/** Resolve to `"timeout"` after `ms`, without holding the event loop open. */
function expire(ms: number): Promise<"timeout"> {
  return new Promise((settle) => {
    setTimeout(() => settle("timeout"), ms).unref?.();
  });
}

/**
 * Choose between the root-level and `src/`-nested layouts. A project
 * uses one or the other; when both hold convention folders the root
 * wins and the other is reported rather than silently dropped.
 */
function pickContentRoot(root: string): string {
  const src = join(root, "src");
  const rootHas = CONVENTION_FOLDERS.some((f) => isDirectory(join(root, f)));
  const srcHas = CONVENTION_FOLDERS.some((f) => isDirectory(join(src, f)));
  if (rootHas && srcHas) {
    logger.warn(
      `Convention folders exist both at "${root}" and "${src}". Using the root-level layout; the ones under "src" are ignored. Move them into one place.`,
    );
  }
  if (rootHas) return root;
  return srcHas ? src : root;
}

/**
 * Run every registered discoverer whose folder is present, in order,
 * threading the growing configuration through so a later discoverer
 * sees what an earlier one contributed.
 *
 * A convention folder that needs a discoverer and has none fails here
 * rather than booting a project with an agent quietly missing.
 */
async function applyDiscoverers(
  projectRoot: string,
  contentRoot: string,
  config: CraftConfig,
): Promise<CraftConfig> {
  const discoverers = getProjectDiscoverers();
  let out = config;
  for (const { folder, discover } of discoverers) {
    const directory = join(contentRoot, folder);
    if (!isDirectory(directory)) continue;
    out = mergeProjectConfig(
      out,
      await discover({ directory, contentRoot, projectRoot, config: out }),
    );
  }
  const registered = new Set(discoverers.map((d) => d.folder));
  for (const folder of DISCOVERED_FOLDERS) {
    if (registered.has(folder)) continue;
    if (!isDirectory(join(contentRoot, folder))) continue;
    throw new Error(
      `"${folder}/" exists at "${contentRoot}" but nothing knows how to load it. Install @routecraft/ai and import it for its side effects from ${CONFIG_STEM}.ts:\n\n  import "@routecraft/ai";\n\nA type-only import (\`import type { ... } from "@routecraft/ai"\`) is erased at compile time and does not register anything, so an import statement that looks correct can still produce this error.`,
    );
  }
  return out;
}

/**
 * Import every module under `plugins/` and collect the plugin each one
 * default-exports.
 */
async function loadPlugins(root: string, dir: string): Promise<CraftPlugin[]> {
  const out: CraftPlugin[] = [];
  for (const file of discoverPluginModules(dir)) {
    const where = displayPath(root, file);
    const module = await importModule(file, where);
    const exported = module.default;
    if (isPluginInstance(exported)) {
      out.push(exported as CraftPlugin);
      logger.info(`Plugin: loaded from "${where}".`);
      continue;
    }
    if (typeof exported === "function") {
      throw new Error(
        `${where} default-exports a factory, not a plugin instance. A factory needs arguments this runtime cannot invent, so call it in ${CONFIG_STEM}.ts and add the result to \`plugins\`.`,
      );
    }
    throw new Error(
      `${where} must default-export a plugin (an object with an \`apply\` function). Got ${describe(exported)}.`,
    );
  }
  return out;
}

/**
 * Import every capability module and collect the routes each one
 * default-exports.
 */
async function loadCapabilities(
  root: string,
  dir: string,
): Promise<(RouteDefinition | AnyRouteBuilder)[]> {
  const out: (RouteDefinition | AnyRouteBuilder)[] = [];
  for (const file of discoverCapabilityModules(dir)) {
    const where = displayPath(root, file);
    const module = await importModule(file, where);
    const collected = collectRoutes(module.default);
    if (!collected.ok) {
      throw new Error(`${where}: ${collected.reason}`);
    }
    out.push(...collected.routes);
    logger.info(
      `Capability: loaded ${collected.routes.length} route(s) from "${where}".`,
    );
  }
  return out;
}

/**
 * Resolve on the first exchange that reaches a terminal outcome on any
 * route. `--once` treats a failure and a drop as terminal too, so a CI
 * smoke check reports instead of hanging until it is killed.
 */
function watchFirstExchange(
  context: CraftContext,
): Promise<"completed" | "failed" | "dropped"> {
  return new Promise((settle) => {
    const offs: Array<() => void> = [];
    const finish =
      (outcome: "completed" | "failed" | "dropped") => (): void => {
        for (const off of offs) off();
        settle(outcome);
      };
    offs.push(
      context.on("route:exchange:completed", finish("completed")),
      context.on("route:exchange:failed", finish("failed")),
      context.on("route:exchange:dropped", finish("dropped")),
    );
  });
}

/**
 * Import a discovered module, attributing a failure to the file that
 * caused it. `start` walks a whole tree, so "which file" is the only
 * question a bare resolver error leaves unanswered.
 */
async function importModule(
  file: string,
  where: string,
): Promise<{ default?: unknown }> {
  try {
    return (await import(file)) as { default?: unknown };
  } catch (error: unknown) {
    throw new Error(`${where}: failed to import. ${messageOf(error)}`, {
      cause: error,
    });
  }
}

function describe(value: unknown): string {
  if (value === undefined) return "no default export";
  if (value === null) return "null";
  return Array.isArray(value) ? "an array" : typeof value;
}

function fail(message: string): RunResult {
  logger.error(message);
  return { success: false, code: 1, message };
}
