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

  try {
    // Inside the guard: picking the content root consults the discoverer
    // registry, which throws on a dependency cycle, and every failure
    // this command can hit belongs in its RunResult rather than as a
    // rejection its caller has to catch.
    const contentRoot = pickContentRoot(root);
    logger.info(`Starting project "${root}" (content root: "${contentRoot}").`);

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

    // Both watchers subscribe before the first route runs. `start()`
    // emits synchronously before it yields, so anything installed after
    // the call can miss the very events it exists to observe.
    const startupErrors = watchStartupErrors(context);
    const firstExchange = options.once
      ? watchFirstExchange(context)
      : undefined;

    try {
      // `context.start()` deliberately never resolves while a server
      // ingress is held open (see Route.start), so `--once` has to race
      // it rather than await it: awaiting first would mean the flag only
      // worked on projects that were going to exit anyway.
      const started = context.start();
      if (firstExchange === undefined) {
        await started;
        return reportStartup(startupErrors.read());
      }

      const timeout = options.timeoutMs;
      const outcome = await Promise.race([
        firstExchange,
        // Every route finished on its own before any exchange landed.
        started.then(() => "drained" as const),
        ...(timeout === undefined ? [] : [expire(timeout)]),
      ]);

      if (outcome === "drained") {
        await started;
        return reportStartup(startupErrors.read());
      }
      if (outcome === "timeout") {
        await context.stop();
        // Same reason as the shutdown path below: a route rejecting during
        // stop must not turn a diagnosed timeout into an unhandled rejection.
        await started.catch(() => undefined);
        return fail(
          `No exchange reached a terminal outcome within ${String(timeout)}ms. Nothing in this project produced one; check that a source actually fires, or raise --timeout.`,
        );
      }
      logger.info(`Exchange ${outcome}; shutting down (--once).`);
      const shutdown = await context.stop();
      // Attach the start rejection so a route failure during shutdown is
      // reported rather than surfacing as an unhandled rejection.
      await started.catch(() => undefined);
      if (outcome === "failed") {
        return fail(
          "The first exchange failed. See the logged error for the cause.",
        );
      }
      // A forced stop abandoned in-flight work, which is not a clean run
      // whatever the first exchange did. `--once` never reaches
      // `shutdownHandler`, so without this the same binary would report the
      // same event two different ways.
      if (shutdown.forced) {
        return fail(
          `Shutdown was forced after ${String(shutdown.pending.length)} route(s) failed to drain in time${shutdown.pending.length > 0 ? `: ${shutdown.pending.join(", ")}` : ""}. In-flight work was abandoned; raise shutdown.timeoutMs if the work needs longer.`,
        );
      }
      return reportStartup(startupErrors.read());
    } finally {
      startupErrors.off();
    }
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
  // Registered folders count too, so a project whose only convention
  // folder comes from an ecosystem package still resolves its layout.
  // Without them, a `src/`-nested project holding just that folder would
  // fall back to the root and boot without what the discoverer provides.
  const folders = [
    ...CONVENTION_FOLDERS,
    ...getProjectDiscoverers().map((d) => d.folder),
  ];
  const rootHas = folders.some((f) => isDirectory(join(root, f)));
  const srcHas = folders.some((f) => isDirectory(join(src, f)));
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
  const declared = config;
  let out = config;
  for (const { folder, discover } of discoverers) {
    const directory = join(contentRoot, folder);
    if (!isDirectory(directory)) continue;
    out = mergeProjectConfig(
      out,
      await discover({
        directory,
        contentRoot,
        projectRoot,
        config: out,
        declared,
      }),
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

/** How the first exchange ended, for the `--once` shutdown decision. */
type ExchangeOutcome = "completed" | "failed" | "dropped" | "suspended";

/**
 * Resolve on the first exchange that reaches a terminal outcome on any
 * route. `--once` treats a failure, a drop and a suspension as terminal
 * alongside a completion, so a CI smoke check reports instead of
 * hanging until it is killed.
 *
 * A suspension is terminal for the run that produced it: the exchange
 * parks durably and `route:exchange:suspended` takes the place of
 * `:completed`, so waiting for a completion that is not coming is the
 * same hang under a different name.
 *
 * Subscribe before starting the context, never after: `start()` runs a
 * synchronous prefix before it yields, so a source that produces an
 * exchange during route startup would fire into a watcher that does not
 * exist yet.
 */
function watchFirstExchange(context: CraftContext): Promise<ExchangeOutcome> {
  return new Promise((settle) => {
    const offs: Array<() => void> = [];
    const finish = (outcome: ExchangeOutcome) => (): void => {
      for (const off of offs) off();
      settle(outcome);
    };
    offs.push(
      context.on("route:exchange:completed", finish("completed")),
      context.on("route:exchange:failed", finish("failed")),
      context.on("route:exchange:dropped", finish("dropped")),
      context.on("route:exchange:suspended", finish("suspended")),
    );
  });
}

/**
 * Collect route startup failures.
 *
 * `context.start()` settles every route rather than racing them, so it
 * resolves even when a route threw on the way up. Without this the
 * command reports a clean boot for a project that did not boot, which
 * is the one thing a CI gate must never do.
 */
function watchStartupErrors(context: CraftContext): {
  read: () => string[];
  off: () => void;
} {
  const failed: string[] = [];
  const off = context.on("context:error", (event) => {
    // Listeners receive the event envelope, not the payload: the details
    // are one level down.
    const details = (
      event as {
        details?: {
          route?: { definition?: { id?: string } };
          exchange?: unknown;
        };
      }
    ).details;
    // A route-scoped error carrying an exchange is that exchange
    // failing, not the route failing to come up. The pipeline emits the
    // same event for both, and counting a runtime failure as a boot
    // failure would fail a command whose project started perfectly.
    if (details?.exchange !== undefined) return;
    const id = details?.route?.definition?.id;
    if (id !== undefined) failed.push(id);
  });
  // Disposal is separate from reading because most exit paths report a
  // failure without reading, and a programmatic caller keeps the context
  // after the command returns. The caller unsubscribes in a finally so
  // no path leaves the listener attached.
  return { read: () => failed, off };
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

/**
 * Turn collected startup failures into the command's result. A boot
 * where a route never came up is a failed boot, whatever the surviving
 * routes went on to do.
 */
function reportStartup(failedRoutes: readonly string[]): RunResult {
  if (failedRoutes.length === 0) return { success: true };
  return fail(
    `${String(failedRoutes.length)} route(s) failed to start: ${failedRoutes.join(", ")}. See the logged errors for the cause.`,
  );
}

function fail(message: string): RunResult {
  logger.error(message);
  return { success: false, code: 1, message };
}
