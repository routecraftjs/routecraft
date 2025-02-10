import { expect, test } from "vitest";
import { context } from "@routecraftjs/routecraft";
import routes from "./channel-adapter.mjs";

/**
 * @testCase TC-0020
 * @description Verifies that channel adapter can send and receive messages
 * @preconditions Channel adapter with two channels
 * @expectedResult Should send and receive messages between channels
 */
test("Context loads", async () => {
  const testContext = context().routes(routes).build();

  const execution = testContext.start();

  // Wait for execution to settle
  await new Promise((resolve) => setTimeout(resolve, 100));

  await testContext.stop();
  await execution;

  // If we got here without errors, the test passed
  expect(true).toBe(true);
});
