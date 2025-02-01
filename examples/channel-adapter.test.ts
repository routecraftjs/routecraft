import { expect, test } from "vitest";
import { channel, context, log, routes, simple } from "@routecraft/dsl";

test("Context loads", async () => {
  const testContext = context()
    .routes(
      routes()
        .from(
          { id: "hello-world" },
          simple(() => "hello-world"),
        )
        .to(channel("hello-world"))
        .from(channel("hello-world"))
        .to(log()),
    )
    .build();

  const execution = testContext.start();

  // Wait for execution to settle
  await new Promise((resolve) => setTimeout(resolve, 100));

  await testContext.stop();
  await execution;

  // If we got here without errors, the test passed
  expect(true).toBe(true);
});
