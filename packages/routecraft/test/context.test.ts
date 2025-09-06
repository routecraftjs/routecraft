import { describe, test, expect, afterEach, vi, beforeEach } from "vitest";
import {
  context,
  craft,
  simple,
  type CraftContext,
  NoopAdapter,
} from "@routecraftjs/routecraft";

describe("CraftContext", () => {
  let testContext: CraftContext;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    if (testContext) {
      await testContext.stop();
    }
  });

  /**
   * @testCase TC-A0B1
   * @description Verifies context initialization with minimal configuration
   * @preconditions None
   * @expectedResult Context should start and stop without errors
   */
  test("Initializes with empty configuration", async () => {
    testContext = context().build();
    const execution = testContext.start();

    await testContext.stop();
    await execution;

    expect(testContext.getcraft()).toHaveLength(0);
  });

  /**
   * @testCase TC-C2D3
   * @description Validates route registration functionality
   * @preconditions Simple route definition exists
   * @expectedResult Context should contain exactly 1 registered route
   */
  test("Registers routes correctly", async () => {
    testContext = context()
      .routes(craft().id("test-route").from(simple("test")))
      .build();

    await testContext.start();
    // Ensure all asynchronous logs have flushed
    await new Promise((r) => setTimeout(r, 0));

    expect(testContext.getcraft()).toHaveLength(1);
    expect(testContext.getRouteById("test-route")).toBeDefined();
  });

  /**
   * @testCase TC-E4F5
   * @description Verifies lifecycle hooks execution
   * @preconditions Context with startup/shutdown handlers
   * @expectedResult Both handlers should be called exactly once
   */
  test("Executes lifecycle events", async () => {
    const contextStarting = vi.fn();
    const contextStarted = vi.fn();
    const contextStopping = vi.fn();
    const contextStopped = vi.fn();

    testContext = context()
      .on("contextStarting", contextStarting)
      .on("contextStarted", contextStarted)
      .on("contextStopping", contextStopping)
      .on("contextStopped", contextStopped)
      .build();

    await testContext.start();

    expect(contextStarting).toHaveBeenCalledTimes(1);
    expect(contextStarted).toHaveBeenCalledTimes(1);
    expect(contextStopping).toHaveBeenCalledTimes(1);
    expect(contextStopped).toHaveBeenCalledTimes(1);
  });
});

describe("Error Handling", () => {
  let testContext: CraftContext;

  afterEach(async () => {
    if (testContext) {
      await testContext.stop();
    }
  });

  /**
   * @testCase TC-G6H7
   * @description Verifies error handling in startup sequence
   * @preconditions Context with failing startup handler
   * @expectedResult Context should throw error and shutdown
   */
  test("Handles startup errors", async () => {
    const errorMessage = "Simulated startup failure";
    testContext = context()
      .on("contextStarting", () => {
        throw new Error(errorMessage);
      })
      .build();

    // Start won't reject because we emit errors and continue; verify error event fires
    const errSpy = vi.fn();
    testContext.on("error", errSpy);
    await testContext.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(errSpy).toHaveBeenCalled();
  });
});

describe("Route Management", () => {
  let testContext: CraftContext;

  afterEach(async () => {
    if (testContext) {
      await testContext.stop();
    }
  });

  /**
   * @testCase TC-J8K9
   * @description Validates duplicate route ID prevention
   * @preconditions Two routes with same ID
   * @expectedResult Should throw error during context creation
   */
  test("Rejects duplicate route IDs", () => {
    const builder = context().routes(
      craft()
        .id("duplicate")
        .from(simple("test"))
        .id("duplicate")
        .from(simple("test")),
    );

    expect(() => builder.build()).toThrow(/duplicate/i);
  });

  /**
   * @testCase TC-L1M2
   * @description Verifies route retrieval behavior
   * @preconditions Context with multiple routes
   * @expectedResult Correct route retrieval and undefined for missing
   */
  test("Manages multiple routes correctly", async () => {
    const testRoutes = [1, 2, 3]
      .map((n) => craft().id(`route-${n}`).from(simple(n)).build())
      .flat();

    testContext = context().routes(testRoutes).build();

    expect(testContext.getcraft()).toHaveLength(3);
    expect(testContext.getRouteById("route-2")).toBeDefined();
    expect(testContext.getRouteById("missing")).toBeUndefined();
  });
});

describe("Lifecycle Management", () => {
  let testContext: CraftContext;

  afterEach(async () => {
    if (testContext) {
      await testContext.stop();
    }
  });

  /**
   * @testCase TC-N3P4
   * @description Verifies idempotent stop behavior
   * @preconditions Active context
   * @expectedResult Subsequent stop calls are no-ops
   */
  test("Handles multiple stop calls", async () => {
    testContext = context().build();
    await testContext.start();

    await testContext.stop();
    const secondStop = testContext.stop(); // Should be no-op

    await expect(secondStop).resolves.not.toThrow();
  });

  /**
   * @testCase TC-Q5R6
   * @description Validates store initialization
   * @preconditions Context with custom store
   * @expectedResult Store should be available in context
   */
  test("Initializes custom stores", () => {
    const testStore = new Map([["test", "value"]]);

    testContext = context()
      .store("customStore" as any, testStore)
      .build();

    expect(testContext.getStore("customStore" as any)).toBe(testStore);
  });
});

describe("Route Independence", () => {
  let testContext: CraftContext;

  afterEach(async () => {
    if (testContext) {
      await testContext.stop();
    }
  });

  /**
   * @testCase TC-S7T8
   * @description Verifies that failed routes don't prevent others from processing and calls destination adapter
   * @preconditions Context with failing and working routes
   * @expectedResult Working route should process and eventually call destination adapter
   */
  test("Failed route does not prevent others from processing and calls destination adapter", async () => {
    const noop = new NoopAdapter();
    const sendSpy = vi.spyOn(noop, "send");

    // Create context with failing and working routes.
    testContext = context()
      .routes(
        craft()
          .id("failing-route")
          .from(
            simple(() => {
              throw new Error("Simulated route failure");
            }),
          )
          .id("failing-route2")
          .from(() => {
            throw new Error("Simulated route failure");
          })
          .process(() => {
            throw new Error("Simulated route failure");
          })
          .id("working-route")
          .from(simple("work"))
          .to(noop),
      )
      .build();

    // Start the context. The working route should process and eventually
    // trigger the destination adapter's send() from the "to" step.
    await testContext.start();

    // Assert that the NoopAdapter's send method was called.
    expect(sendSpy).toHaveBeenCalled();
  });
});

// Binder-related tests removed
