import type { CraftContext, CraftPlugin } from "../../context.ts";
import { rcError } from "../../error.ts";
import { type Duration, parseDuration } from "../../shared/duration.ts";
import { startServer, type HttpServerHandle } from "../http/server/index.ts";
import { HttpMountRegistry, WEB_INGRESSES } from "./registry.ts";
import type { ServerDefinitions } from "./types.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;

/**
 * Resolve one server's `shutdownGrace` to milliseconds, defaulting when it is
 * unset. `0` is legal here (close the listener immediately), which is why the
 * floor is 0 rather than the deadline default of 1.
 *
 * @param name - Server name, quoted in the refusal so a multi-server config
 *   says which entry is wrong.
 */
function resolveShutdownGrace(
  name: string,
  grace: Duration | undefined,
): number {
  if (grace === undefined) return DEFAULT_SHUTDOWN_GRACE_MS;
  return parseDuration(grace, `servers.${name}.shutdownGrace`, 0);
}

async function closeServer(
  handle: HttpServerHandle,
  graceMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => resolve("deadline"), graceMs);
      // The grace timer must never itself hold the process open.
      (timer as { unref?: () => void }).unref?.();
    });
    const outcome = await Promise.race([
      handle.gracefulClose().then(
        () => "closed" as const,
        // A rejecting graceful close is a failed graceful close, not a
        // reason to skip the force path and leave the listener running.
        () => "graceful-failed" as const,
      ),
      deadline,
    ]);
    if (outcome !== "closed") await handle.forceClose();
  } finally {
    // finally, not inline: a rejecting gracefulClose must not leave the
    // timer pending for the rest of the grace period.
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface ServerState {
  registries: Map<string, HttpMountRegistry>;
  handles: Map<string, HttpServerHandle>;
  /** Set at teardown entry so a bind racing stop() closes itself. */
  closed: boolean;
  /** In-flight start(), awaited by teardown so stop() cannot resolve while a raced bind is still open. */
  starting?: Promise<void>;
}

export function serversPlugin(definitions: ServerDefinitions): CraftPlugin {
  validateDefinitions(definitions);
  const states = new WeakMap<CraftContext, ServerState>();

  return {
    name: "servers",
    keepsAlive: true,
    apply(ctx) {
      const registries = new Map<string, HttpMountRegistry>();
      for (const name of Object.keys(definitions)) {
        registries.set(
          name,
          new HttpMountRegistry(name, ctx, definitions[name]?.auth),
        );
      }
      states.set(ctx, { registries, handles: new Map(), closed: false });
      ctx.setStore(WEB_INGRESSES, registries);
    },
    async start(ctx) {
      const state = states.get(ctx);
      if (!state) return;
      const boot = bindAll(ctx, state);
      state.starting = boot;
      await boot;
    },
    async teardown(ctx) {
      const state = states.get(ctx);
      if (!state) return;
      state.closed = true;
      // A raced start() closes its own in-flight bind on seeing `closed`;
      // waiting for it here keeps stop() from resolving while that listener
      // is still open. Its failure is the start path's to report.
      await state.starting?.catch(() => {});
      for (const [name, handle] of [...state.handles].reverse()) {
        try {
          await closeServer(
            handle,
            resolveShutdownGrace(name, definitions[name]?.shutdownGrace),
          );
          ctx.logger.info({ server: name }, "Server closed");
          ctx.emit("server:closed", { server: name });
        } catch (error) {
          ctx.logger.warn(
            { err: error, server: name },
            "Named server failed to close cleanly",
          );
        }
      }
      states.delete(ctx);
    },
  };

  async function bindAll(ctx: CraftContext, state: ServerState): Promise<void> {
    assertEveryServerMounted(state.registries);
    for (const registry of state.registries.values()) registry.validate();
    for (const [name, definition] of Object.entries(definitions)) {
      const registry = state.registries.get(name)!;
      const host = definition.host ?? DEFAULT_HOST;
      let handle: HttpServerHandle;
      try {
        handle = await startServer({
          host,
          port: definition.port,
          fetch: (request, runtime) => registry.dispatch(request, runtime),
          logger: ctx.logger,
        });
      } catch (error) {
        ctx.emit("server:failed", { server: name, error });
        throw rcError("RC5019", error, {
          message: `servers.${name}: bind failed on ${host}:${definition.port}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      // A stop() arriving while the bind above was in flight has already
      // run teardown past this server; record nothing and close the fresh
      // handle here or it leaks with nothing left to ever close it.
      if (state.closed) {
        await closeServer(
          handle,
          resolveShutdownGrace(name, definition.shutdownGrace),
        );
        return;
      }
      state.handles.set(name, handle);
      registry.setBoundAddress(host, handle.port);
      ctx.logger.info(
        { server: name, host, port: handle.port },
        "Server listening",
      );
      ctx.emit("server:listening", { server: name, host, port: handle.port });
    }
  }
}

/**
 * Refuse declared servers that nothing mounted on, naming the whole mount
 * topology in the message.
 *
 * The check lives here rather than on the registry because a registry only
 * knows its own mounts, and the fact a reader needs is the one it cannot
 * see: what mounted somewhere else. An empty server almost always means the
 * surface meant for it never mounted (a plugin that failed to apply, a
 * misspelt server name, or a plugin predating named servers), and the mount
 * list is what makes that visible at a glance. Every empty server is
 * reported at once so an app declaring several does not learn about them one
 * boot at a time.
 */
function assertEveryServerMounted(
  registries: ReadonlyMap<string, HttpMountRegistry>,
): void {
  const empty: string[] = [];
  const mounted: string[] = [];
  for (const [name, registry] of registries) {
    const ids = registry.mountIds();
    if (ids.length === 0) {
      empty.push(name);
      continue;
    }
    for (const id of ids) mounted.push(`${id} -> servers.${name}`);
  }
  if (empty.length === 0) return;
  const subject =
    empty.length === 1
      ? `servers.${empty[0]}: server has no mounts.`
      : `servers: ${empty.map((name) => `"${name}"`).join(", ")} have no mounts.`;
  const topology =
    mounted.length > 0
      ? ` Mounted surfaces: ${mounted.join(", ")}.`
      : " No surface mounted on any server.";
  throw rcError("RC5003", undefined, {
    message:
      `${subject}${topology} Either remove the unused ${empty.length === 1 ? "server" : "servers"}, or bind a surface to ${empty.length === 1 ? "it" : "them"}. ` +
      "A surface that names the server in config but did not mount is usually a plugin that failed to apply, a misspelt server name, or a plugin version that predates named servers.",
  });
}

function validateDefinitions(definitions: ServerDefinitions): void {
  const entries = Object.entries(definitions);
  if (entries.length === 0) {
    throw rcError("RC5003", undefined, {
      message: "servers: define at least one named server",
    });
  }
  const binds = new Map<string, string>();
  for (const [name, definition] of entries) {
    if (!name) {
      throw rcError("RC5003", undefined, {
        message: "servers: names must not be empty",
      });
    }
    if (definition.kind !== undefined && definition.kind !== "http") {
      throw rcError("RC5003", undefined, {
        message: `servers.${name}: unsupported kind ${JSON.stringify(definition.kind)}. Supported: "http".`,
      });
    }
    if (
      !Number.isInteger(definition.port) ||
      definition.port < 0 ||
      definition.port > 65535
    ) {
      throw rcError("RC5003", undefined, {
        message: `servers.${name}: invalid port ${String(definition.port)}`,
      });
    }
    resolveShutdownGrace(name, definition.shutdownGrace);
    const host = (definition.host ?? DEFAULT_HOST).toLowerCase();
    const key = `${host}:${definition.port}`;
    const existing = binds.get(key);
    if (existing) {
      throw rcError("RC5003", undefined, {
        message: `servers.${name}: duplicate bind ${key}, already declared by servers.${existing}`,
      });
    }
    if (definition.port !== 0) binds.set(key, name);
  }
}
