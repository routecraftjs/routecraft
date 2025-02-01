import { expect, test } from "vitest";
import { context } from "@routecraft/dsl";
import routes from "./channel-adapter.ts";

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
