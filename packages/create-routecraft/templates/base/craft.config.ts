import { defineConfig } from "@routecraft/routecraft";
import "@routecraft/ai";

/**
 * `mcp: {}` serves every capability with an `mcp()` source as a tool over
 * stdio: an agent spawns `craft start` and talks to it on the process's
 * standard streams, with no port and no credential, which is right for one
 * person's laptop. A team harness serves MCP over HTTP behind authentication
 * instead; see https://routecraft.dev/docs/introduction/expose-to-an-agent.
 *
 * The bare `@routecraft/ai` import is what registers the `mcp` key, so it
 * stays here rather than relying on a capability that happens to import it.
 */
export const craftConfig = defineConfig({
  mcp: {},
});
