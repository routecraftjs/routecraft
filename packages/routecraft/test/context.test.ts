import { describe, test, expect, afterEach, vi, beforeEach } from "vitest";
import {
  context,
  routes,
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
   * @testCase TC-0001
   * @description Verifies context initialization with minimal configuration
   * @preconditions None
   * @expectedResult Context should start and stop without errors
   */
  test("Initializes with empty configuration", async () => {
    testContext = context().build();
    const execution = testContext.start();

    await testContext.stop();
    await execution;

    expect(testContext.getRoutes()).toHaveLength(0);
  });

  /**
   * @testCase TC-0002
   * @description Validates route registration functionality
   * @preconditions Simple route definition exists
   * @expectedResult Context should contain exactly 1 registered route
   */
  test("Registers routes correctly", async () => {
    testContext = context()
      .routes(routes().from([{ id: "test-route" }, simple("test")]))
      .build();

    await testContext.start();
    // Ensure all asynchronous logs have flushed
    await new Promise((r) => setTimeout(r, 0));

    expect(testContext.getRoutes()).toHaveLength(1);
    expect(testContext.getRouteById("test-route")).toBeDefined();
  });

  /**
   * @testCase TC-0003
   * @description Verifies lifecycle hooks execution
   * @preconditions Context with startup/shutdown handlers
   * @expectedResult Both handlers should be called exactly once
   */
  test("Executes lifecycle hooks", async () => {
    const startupMock = vi.fn();
    const shutdownMock = vi.fn();

    testContext = context()
      .onStartup(startupMock)
      .onShutdown(shutdownMock)
      .build();

    await testContext.start();

    expect(startupMock).toHaveBeenCalledTimes(1);
    // Stop is automatically called when the context has nothing more to do
    expect(shutdownMock).toHaveBeenCalledTimes(1);
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
   * @testCase TC-0004
   * @description Verifies error handling in startup sequence
   * @preconditions Context with failing startup handler
   * @expectedResult Context should throw error and shutdown
   */
  test("Handles startup errors", async () => {
    const errorMessage = "Simulated startup failure";
    const startupMock = vi.fn().mockRejectedValue(new Error(errorMessage));

    testContext = context().onStartup(startupMock).build();

    await expect(testContext.start()).rejects.toThrow(errorMessage);
    expect(startupMock).toHaveBeenCalledTimes(1);
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
   * @testCase TC-0005
   * @description Validates duplicate route ID prevention
   * @preconditions Two routes with same ID
   * @expectedResult Should throw error during context creation
   */
  test("Rejects duplicate route IDs", () => {
    const builder = context().routes(
      routes()
        .from([{ id: "duplicate" }, simple("test")])
        .from([{ id: "duplicate" }, simple("test")]),
    );

    expect(() => builder.build()).toThrow(/duplicate/i);
  });

  /**
   * @testCase TC-0006
   * @description Verifies route retrieval behavior
   * @preconditions Context with multiple routes
   * @expectedResult Correct route retrieval and undefined for missing
   */
  test("Manages multiple routes correctly", async () => {
    const testRoutes = [1, 2, 3]
      .map((n) =>
        routes()
          .from([{ id: `route-${n}` }, simple(n)])
          .build(),
      )
      .flat();

    testContext = context().routes(testRoutes).build();

    expect(testContext.getRoutes()).toHaveLength(3);
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
   * @testCase TC-0007
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
   * @testCase TC-0008
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
   * @testCase TC-0009
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
        routes()
          .from([
            { id: "failing-route" },
            simple(() => {
              throw new Error("Simulated route failure");
            }),
          ])
          .from([
            { id: "failing-route2" },
            () => {
              throw new Error("Simulated route failure");
            },
          ])
          .process(() => {
            throw new Error("Simulated route failure");
          })
          .from([{ id: "working-route" }, simple("work")])
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
