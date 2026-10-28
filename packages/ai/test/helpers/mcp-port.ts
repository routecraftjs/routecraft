import type { CraftContext, Plugin } from "@routecraft/routecraft";
import {
  AUTHORITY,
  ENFORCEMENT,
  WEB_INGRESS,
  authorityOf,
} from "@routecraft/routecraft";
import { MCP, createMcpService, type McpService } from "../../src/mcp/port.ts";
import { McpServer } from "../../src/mcp/server.ts";
import type { McpPluginOptions } from "../../src/mcp/types.ts";

/** What a test seeds the MCP service with. */
export type McpSeed = Parameters<typeof createMcpService>[0];

/**
 * A plugin that provides the MCP port without starting a server or any
 * client: what a test needs for `.from(mcp())` routes, the `mcp()` client
 * and agent MCP tools, seeded with whatever registries the test builds.
 */
export function mcpPort(seed: McpSeed = {}): Plugin {
  return {
    id: "test.mcp",
    provides: [MCP],
    bind(c) {
      c.provide(MCP, createMcpService(seed));
    },
  };
}

/** The MCP service a test context holds, provided by {@link mcpPort}. */
export function mcpService(ctx: CraftContext): McpService {
  const service = ctx.lookup(MCP);
  if (!service) throw new Error("the test context does not provide MCP");
  return service;
}

/**
 * An MCP server over a test context, the way `mcpPlugin` builds one: the
 * context's MCP service when it has one, an empty one otherwise.
 */
export function mcpServerFor(
  ctx: CraftContext,
  options: McpPluginOptions = {},
): McpServer {
  return new McpServer(
    {
      logger: ctx.logger,
      emit: (event, details) => ctx.emit(event, details),
      observe: (event, handler) => ctx.on(event, handler),
      service: ctx.lookup(MCP) ?? createMcpService(),
      ingress: ctx,
      authority: authorityOf(ctx),
      enforcement: () => ctx.lookup(ENFORCEMENT),
    },
    options,
  );
}

/**
 * The MCP plugin's server over a seeded service, for an HTTP suite that
 * needs registered clients with tools but no real client process: provides
 * the port from the seed and mounts the server the way `mcpPlugin` does.
 */
export function mcpServerPlugin(
  seed: McpSeed,
  options: McpPluginOptions,
): Plugin {
  const servers = new WeakMap<object, McpServer>();
  return {
    id: "test.mcp.server",
    provides: [MCP],
    requires: [AUTHORITY],
    optional: [WEB_INGRESS, ENFORCEMENT],
    async bind(c) {
      const service = createMcpService(seed);
      c.provide(MCP, service);
      const server = new McpServer(
        {
          logger: c.logger,
          emit: (event, details) => c.emit(event, details),
          observe: (event, handler) => c.observe(event, handler),
          service,
          ingress: c,
          authority: c.require(AUTHORITY),
          enforcement: () => c.lookup(ENFORCEMENT),
        },
        options,
      );
      servers.set(c, server);
      c.onDispose(async () => {
        servers.delete(c);
        await server.stop();
      });
      await server.prepare();
    },
    async start(c) {
      await servers.get(c)?.start();
    },
  };
}
