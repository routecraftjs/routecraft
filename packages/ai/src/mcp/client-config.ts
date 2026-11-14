import type { StdioClientManagerOptions } from "./stdio-client-manager.ts";
import type { McpClientHttpConfig, McpClientStdioConfig } from "./types.ts";

/** @internal */
export function isStdioConfig(
  config: McpClientHttpConfig | McpClientStdioConfig,
): config is McpClientStdioConfig {
  return "transport" in config && config.transport === "stdio";
}

/**
 * What a stdio client's subprocess is started with, under the given
 * restart policy. Shared by the application and `craft mcp pin`, so both
 * run the server the same way.
 *
 * @internal
 */
export function stdioManagerOptions(
  serverId: string,
  config: McpClientStdioConfig,
  restart: Pick<
    StdioClientManagerOptions,
    "maxRestarts" | "restartDelayMs" | "restartBackoffMultiplier"
  >,
): StdioClientManagerOptions {
  return {
    serverId,
    command: config.command,
    args: config.args ?? [],
    ...(config.env !== undefined ? { env: config.env } : {}),
    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    ...restart,
  };
}
