import { ContextBuilder, craft, http, noop } from "@routecraft/routecraft";

/**
 * Capability under test for the k6 performance scenario: an HTTP source
 * route with a small transform pipeline, representative of a typical
 * request/response capability. Run with `bun run perf:serve`, then drive
 * it with `bun run perf:k6` (see README.md).
 */
const port = Number(process.env["PORT"] ?? 4180);

const routes = craft()
  .id("bench-http")
  .from(http({ path: "/bench", method: "POST" }))
  .transform((body) => ({ payload: body, validated: true }))
  .transform((shaped) => ({ ...shaped, enriched: true }))
  .transform((shaped) => ({ ...shaped, done: true }))
  .to(noop());

const { context } = await new ContextBuilder()
  .on("plugin:http:server:listening", ({ details }) => {
    process.stdout.write(
      `bench capability listening on http://${details.host}:${details.port}\n`,
    );
  })
  .routes(routes)
  .with({ http: { port } })
  .build();

process.on("SIGINT", () => void context.stop());
process.on("SIGTERM", () => void context.stop());

await context.start();
