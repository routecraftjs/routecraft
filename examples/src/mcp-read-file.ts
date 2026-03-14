import { craft, log, simple } from "@routecraft/routecraft";
import { mcp, mcpPlugin } from "@routecraft/ai";

/**
 * Example: read a file via the MCP filesystem server (stdio subprocess).
 *
 * The plugin spawns `@modelcontextprotocol/server-filesystem` as a child
 * process, connects over stdio, and exposes its tools. The route calls the
 * "read_file" tool to read a file from /tmp.
 *
 * To test:
 *   echo "Hello from MCP filesystem!" > /tmp/hello.txt
 *   npx tsx src/mcp-read-file.ts
 */

export const craftConfig = {
  plugins: [
    mcpPlugin({
      name: "routecraft",
      version: "1.0.0",
      transport: "stdio",
      clients: {
        filesystem: {
          transport: "stdio" as const,
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        },
      },
    }),
  ],
};

export default craft()
  .id("mcp-read-file")
  .from(simple({ path: "/tmp/hello.txt" }))
  .to(
    mcp("filesystem:read_file", {
      args: (ex) => ({ path: ex.body.path }),
    }),
  )
  .tap(log());
