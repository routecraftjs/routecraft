import { expect, test } from "vitest";
import { context } from "@routecraftjs/routecraft";
import routes from "./hello-world.mjs";

/**
 * @testCase TC-A7B8
 * @description Verifies that the context loads
 * @preconditions Routes are defined
 * @expectedResult Should load context without errors
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
