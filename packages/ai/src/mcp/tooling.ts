import type { CredentialLogin, PluginTooling } from "@routecraft/routecraft";
import { connectLogin, isConnectAuth } from "./connect.ts";
import { mcpPinCommand } from "./pin-command.ts";
import type { McpPluginOptions } from "./types.ts";

/**
 * What the MCP plugin gives the command line: `craft mcp pin`, and the
 * login of every client declared with `connect()` for `craft connect`.
 *
 * @internal
 */
export function mcpTooling(options: McpPluginOptions): PluginTooling {
  return {
    commands: { pin: mcpPinCommand(options) },
    logins: () => {
      const logins: CredentialLogin[] = [];
      for (const [serverId, client] of Object.entries(options.clients ?? {})) {
        if ("url" in client && isConnectAuth(client.auth)) {
          logins.push(
            connectLogin(serverId, client.url, client.auth, {
              allowHttp: client.allowHttp,
            }),
          );
        }
      }
      return logins;
    },
  };
}
