import { defineConfig } from "@routecraft/routecraft";

/**
 * `mcp: {}` serves every capability with an `mcp()` source as a tool over
 * stdio: an agent spawns `craft start` and talks to it on the process's
 * standard streams, with no port and no credential, which is right for one
 * person's laptop. A team harness serves MCP over HTTP behind authentication
 * instead; see https://routecraft.dev/docs/introduction/expose-to-an-agent.
 */
export const craftConfig = defineConfig({
  mcp: {},
});
