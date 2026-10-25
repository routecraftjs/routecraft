import type { TestContext } from "@routecraft/testing";

/**
 * Start a context and resolve with the port its server bound, read off
 * `server:listening`. For a test whose context listens on port 0.
 *
 * @param t - The built test context
 * @returns The bound port
 */
export async function listen(t: TestContext): Promise<number> {
  let port: number | undefined;
  t.ctx.on("server:listening", ({ details }) => {
    port = details.port;
  });
  await t.startAndWaitReady();
  if (port === undefined) throw new Error("no server reported a port");
  return port;
}
