/**
 * A minimal Routecraft MCP server over stdio, run as a child process by
 * `mcp-stdio.bun.test.ts`.
 *
 * It exists as a real script rather than an in-process fixture because the
 * stdio transport owns the process's stdin and stdout: the only honest way to
 * test it is to speak MCP to a spawned process over a real pipe.
 */
import { craft, noop } from "@routecraft/routecraft";
import { testContext } from "@routecraft/testing";
import { z } from "zod";
import { mcp } from "../../src/index.ts";
import { mcpPort, mcpServerFor } from "../helpers/mcp-port.ts";

const t = await testContext()
  .routes([
    craft()
      .id("shout")
      .title("Shout")
      .description("Uppercase the given phrase")
      .input({ body: z.object({ phrase: z.string() }) })
      .from(mcp())
      .transform((p: { phrase: string }) => ({
        shouted: p.phrase.toUpperCase(),
      }))
      .to(noop()),
  ])
  .with({ plugins: [mcpPort()] })
  .build();

await t.startAndWaitReady();

const server = mcpServerFor(t.ctx, {
  name: "stdio-sample",
  version: "1.0.0",
  transport: "stdio",
});
await server.start();
