import { expect, test, vi } from "vitest";
import { context } from "@routecraftjs/routecraft";
import routes from "./channel-adapter.mjs";

/**
 * @testCase TC-M4N5
 * @description Verifies that channel adapter can send and receive messages
 * @preconditions Channel adapter with two channels
 * @expectedResult Should send and receive messages between channels
 */
test("receives 'Hello, World!' on my-channel-1 and logs it", async () => {
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation(() => undefined as unknown as void);

  const testContext = context().routes(routes).build();

  const execution = testContext.start();

  // Allow time for the simple route to emit and channels to propagate
  await new Promise((resolve) => setTimeout(resolve, 150));

  await testContext.stop();
  await execution;

  // Collect logged exchanges (LogAdapter logs base exchange: { id, body, headers })
  const calls = logSpy.mock.calls.map((c) => c[0]) as Array<
    { headers?: Record<string, unknown>; body?: unknown } | unknown
  >;

  // Filter logs for the consumer route that subscribes to my-channel-1
  const logsForChannel1Route = calls.filter(
    (arg) =>
      typeof arg === "object" &&
      arg != null &&
      "headers" in arg &&
      (arg as { headers?: Record<string, unknown> }).headers?.[
        "routecraft.route"
      ] === "channel-adapter-1",
  ) as Array<{ headers?: Record<string, unknown>; body?: unknown }>;

  // Ensure we saw at least one log for that route
  expect(logsForChannel1Route.length > 0).toBe(true);

  // Verify the body for that route contains the expected message
  const bodies = logsForChannel1Route.map((x) => x.body);
  expect(bodies).toContain("Hello, World!");

  // Also verify second channel route logs transformed content
  const logsForChannel2Route = calls.filter(
    (arg) =>
      typeof arg === "object" &&
      arg != null &&
      "headers" in arg &&
      (arg as { headers?: Record<string, unknown> }).headers?.[
        "routecraft.route"
      ] === "channel-adapter-2",
  ) as Array<{ headers?: Record<string, unknown>; body?: unknown }>;

  expect(logsForChannel2Route.length > 0).toBe(true);
  const bodies2 = logsForChannel2Route.map((x) => x.body);
  expect(bodies2).toContain("Hello, World! 2");

  logSpy.mockRestore();
});
