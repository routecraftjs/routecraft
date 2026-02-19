import { expect, test, vi } from "vitest";
import { testContext } from "@routecraft/routecraft";
import routes from "./direct-adapter.mjs";

/**
 * @case Verifies that direct adapter can send and receive messages
 * @preconditions Channel adapter with two directs
 * @expectedResult Should send and receive messages between directs
 */
test("receives 'Hello, World!' on my-direct-1 and logs it", async () => {
  const t = await testContext().routes(routes).build();
  await t.test();

  // Collect logged exchanges (LogAdapter logs base exchange: { id, body, headers })
  // pino.info() is called with (object, message) format - first arg is the data
  const infoSpy = t.logger.info as ReturnType<typeof vi.fn>;
  const calls = infoSpy.mock.calls.map((c) => c[0]) as Array<
    { headers?: Record<string, unknown>; body?: unknown } | unknown
  >;

  // Filter logs for the consumer route that subscribes to my-direct-1
  const logsForChannel1Route = calls.filter(
    (arg) =>
      typeof arg === "object" &&
      arg != null &&
      "headers" in arg &&
      (arg as { headers?: Record<string, unknown> }).headers?.[
        "routecraft.route"
      ] === "direct-adapter-1",
  ) as Array<{ headers?: Record<string, unknown>; body?: unknown }>;

  // Ensure we saw at least one log for that route
  expect(logsForChannel1Route.length > 0).toBe(true);

  // Verify the body for that route contains the expected message
  const bodies = logsForChannel1Route.map((x) => x.body);
  expect(bodies).toContain("Hello, World!");

  // Also verify second direct route logs transformed content
  const logsForChannel2Route = calls.filter(
    (arg) =>
      typeof arg === "object" &&
      arg != null &&
      "headers" in arg &&
      (arg as { headers?: Record<string, unknown> }).headers?.[
        "routecraft.route"
      ] === "direct-adapter-2",
  ) as Array<{ headers?: Record<string, unknown>; body?: unknown }>;

  expect(logsForChannel2Route.length > 0).toBe(true);
  const bodies2 = logsForChannel2Route.map((x) => x.body);
  expect(bodies2).toContain("Hello, World! 2");
});
