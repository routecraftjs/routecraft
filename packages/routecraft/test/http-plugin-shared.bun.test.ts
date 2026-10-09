import { afterEach, describe, expect, test } from "bun:test";
import {
  ContextBuilder,
  craft,
  http,
  httpPlugin,
  type CraftContext,
  type Plugin,
} from "../src/index.ts";

interface App {
  readonly context: CraftContext;
  readonly port: number;
  readonly running: Promise<unknown>;
}

async function boot(id: string, plugin: Plugin): Promise<App> {
  const { context } = await new ContextBuilder()
    .with({
      servers: { default: { port: 0, host: "127.0.0.1" } },
      plugins: [plugin],
    })
    .routes([
      craft()
        .id(id)
        .from(http({ path: `/${id}`, method: "GET" }))
        .transform(() => ({ app: id })),
    ])
    .build();
  let port = 0;
  context.on("server:listening", ({ details }) => {
    port = details.port;
  });
  const running = context.start();
  running.catch(() => undefined);
  await context.whenStarted();
  return { context, port, running };
}

async function status(app: App, path: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${app.port}${path}`);
  await response.arrayBuffer();
  return response.status;
}

describe("one HTTP plugin descriptor in two applications", () => {
  const apps: App[] = [];

  afterEach(async () => {
    for (const app of apps.splice(0).reverse()) {
      await app.context.stop();
      await app.running;
    }
  });

  /**
   * @case One httpPlugin({}) object is installed in two contexts with separate listeners and one route each
   * @preconditions Both are started
   * @expectedResult Each listener serves its own route only, and stopping the first leaves the second serving: mount tables and unmounts belong to the application, not the descriptor
   */
  test("keeps routes and teardown per application", async () => {
    const shared = httpPlugin({});
    const a = await boot("only-a", shared);
    const b = await boot("only-b", shared);
    apps.push(a, b);

    expect(await status(a, "/only-a")).toBe(200);
    expect(await status(b, "/only-b")).toBe(200);
    expect(await status(a, "/only-b")).toBe(404);
    expect(await status(b, "/only-a")).toBe(404);

    await a.context.stop();
    await a.running;
    apps.splice(apps.indexOf(a), 1);

    expect(await status(b, "/only-b")).toBe(200);
  });
});
