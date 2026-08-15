import type { CraftContext, CraftPlugin } from "../../context.ts";
import { rcError } from "../../error.ts";
import { startServer, type HttpServerHandle } from "../http/server/index.ts";
import { HttpMountRegistry, WEB_INGRESSES } from "./registry.ts";
import type { ServerDefinitions } from "./types.ts";

const DEFAULT_HOST = "127.0.0.1";

export function serversPlugin(definitions: ServerDefinitions): CraftPlugin {
  validateDefinitions(definitions);
  const states = new WeakMap<
    CraftContext,
    {
      registries: Map<string, HttpMountRegistry>;
      handles: Map<string, HttpServerHandle>;
    }
  >();

  return {
    name: "servers",
    apply(ctx) {
      const registries = new Map<string, HttpMountRegistry>();
      for (const name of Object.keys(definitions)) {
        registries.set(name, new HttpMountRegistry(name));
      }
      states.set(ctx, { registries, handles: new Map() });
      ctx.setStore(WEB_INGRESSES, registries);
    },
    async start(ctx) {
      const state = states.get(ctx);
      if (!state) return;
      for (const [name, definition] of Object.entries(definitions)) {
        const registry = state.registries.get(name)!;
        registry.validate();
        const host = definition.host ?? DEFAULT_HOST;
        let handle: HttpServerHandle;
        try {
          handle = await startServer({
            host,
            port: definition.port,
            fetch: (request) => registry.dispatch(request),
          });
        } catch (error) {
          throw rcError("RC5019", error, {
            message: `servers.${name}: bind failed on ${host}:${definition.port}: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        state.handles.set(name, handle);
        ctx.emit("server:listening", { server: name, host, port: handle.port });
      }
    },
    async teardown(ctx) {
      const state = states.get(ctx);
      if (!state) return;
      for (const [name, handle] of [...state.handles].reverse()) {
        await handle.close();
        ctx.emit("server:closed", { server: name });
      }
      states.delete(ctx);
    },
  };
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
