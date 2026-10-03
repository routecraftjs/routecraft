import type { CraftContext, Plugin } from "@routecraft/routecraft";
import { authorityOf } from "@routecraft/routecraft";
import { MCP, createMcpService, type McpService } from "../../src/mcp/port.ts";
import { McpServer } from "../../src/mcp/server.ts";
import type { McpPluginOptions } from "../../src/mcp/types.ts";

/** What a test seeds the MCP service with. */
export type McpSeed = Partial<
  Pick<McpService, "tools" | "stdio" | "clients" | "local">
>;

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
      c.provide(MCP, { ...createMcpService(), ...seed });
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
    },
    options,
  );
}
