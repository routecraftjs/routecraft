/**
 * Stdio MCP server runner for integration tests.
 * Spawned by the test; reads JSON-RPC from stdin, writes to stdout (newline-delimited).
 * Route "echo-args" returns received body types and values so the test can assert.
 *
 * Run from repo root: node packages/ai/test/stdio-mcp-runner.mjs
 */
import { context, craft, noop } from "@routecraft/routecraft";
import { mcp, McpServer, MCP_PLUGIN_REGISTERED } from "@routecraft/ai";
import { z } from "zod";

async function main() {
  const ctx = await context()
    .routes([
      craft()
        .id("echo-args")
        .from(
          mcp("echo-args", {
            description: "Echo argument types and values for test",
            schema: z.object({
              str: z.string(),
              obj: z.record(z.string(), z.any()),
            }),
          }),
        )
        .transform((body) => ({
          strType: typeof body.str,
          objType: typeof body.obj,
          strVal: body.str,
          objVal: body.obj,
        }))
        .to(noop()),
    ])
    .store(MCP_PLUGIN_REGISTERED, true)
    .build();

  const total = ctx.getRoutes().length;
  const routesReady =
    total === 0
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
          let ready = 0;
          const timeout = setTimeout(
            () => reject(new Error("Timeout waiting for routes")),
            5000,
          );
          const onRouteStarted = () => {
            ready++;
            if (ready >= total) {
              clearTimeout(timeout);
              unsubError();
              resolve();
            }
          };
          const onError = (event) => {
            clearTimeout(timeout);
            unsubRouteStarted();
            reject(event.details.error);
          };
          const unsubRouteStarted = ctx.on("routeStarted", onRouteStarted);
          const unsubError = ctx.on("error", onError);
        });

  ctx.start();
  await routesReady;

  const server = new McpServer(ctx, { transport: "stdio" });
  await server.start();
  // Process stays alive; MCP server reads from stdin
}

main().catch((err) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
