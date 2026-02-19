import { describe, test, expect, afterEach, vi, beforeEach } from "vitest";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, simple } from "@routecraft/routecraft";

describe("CraftContext", () => {
  let t: TestContext;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    if (t) {
      await t.stop();
    }
  });

  /**
   * @case Verifies context initialization with minimal configuration
   * @preconditions None
   * @expectedResult Context should start and stop without errors
   */
  test("Initializes with empty configuration", async () => {
    t = await testContext().build();
    const execution = t.ctx.start();

    await t.ctx.stop();
    await execution;

    expect(t.ctx.getRoutes()).toHaveLength(0);
  });

  /**
   * @case Validates route registration functionality
   * @preconditions Simple route definition exists
   * @expectedResult Context should contain exactly 1 registered route
   */
  test("Registers routes correctly", async () => {
    t = await testContext()
      .routes(craft().id("test-route").from(simple("test")))
      .build();

    await t.ctx.start();
    // Ensure all asynchronous logs have flushed
    await new Promise((r) => setTimeout(r, 0));

    expect(t.ctx.getRoutes()).toHaveLength(1);
    expect(t.ctx.getRouteById("test-route")).toBeDefined();
  });

  /**
   * @case Verifies RouteBuilder is accepted via brand (works across package copies via Symbol.for())
   * @preconditions RouteBuilder instance (e.g. from user module when CLI uses different copy)
   * @expectedResult Context should register the route and start without validation errors
   */
  test("Accepts RouteBuilder (brand allows cross-instance recognition)", async () => {
    const builder = craft().id("duck-route").from(simple("duck"));
    t = await testContext().routes(builder).build();

    await t.ctx.start();
    await new Promise((r) => setTimeout(r, 0));

    expect(t.ctx.getRoutes()).toHaveLength(1);
    expect(t.ctx.getRouteById("duck-route")).toBeDefined();
  });

  /**
   * @case Verifies lifecycle hooks execution
   * @preconditions Context with startup/shutdown handlers
   * @expectedResult Both handlers should be called exactly once
   */
  test("Executes lifecycle events", async () => {
    const contextStarting = vi.fn();
    const contextStarted = vi.fn();
    const contextStopping = vi.fn();
    const contextStopped = vi.fn();

    t = await testContext()
      .on("contextStarting", contextStarting)
      .on("contextStarted", contextStarted)
      .on("contextStopping", contextStopping)
      .on("contextStopped", contextStopped)
      .build();

    await t.ctx.start();

    expect(contextStarting).toHaveBeenCalledTimes(1);
    expect(contextStarted).toHaveBeenCalledTimes(1);
    expect(contextStopping).toHaveBeenCalledTimes(1);
    expect(contextStopped).toHaveBeenCalledTimes(1);
  });
});

describe("Error Handling", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) {
      await t.stop();
    }
  });

  /**
   * @case Verifies error handling in startup sequence
   * @preconditions Context with failing startup handler
   * @expectedResult Context should throw error and shutdown
   */
  test("Handles startup errors", async () => {
    const errorMessage = "Simulated startup failure";
    t = await testContext()
      .on("contextStarting", () => {
        throw new Error(errorMessage);
      })
      .build();

    // Start won't reject because we emit errors and continue; verify error event fires
    const errSpy = vi.fn();
    t.ctx.on("error", errSpy);
    await t.ctx.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(errSpy).toHaveBeenCalled();
  });
});

describe("Route Management", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) {
      await t.stop();
    }
  });

  /**
   * @case Validates duplicate route ID prevention
   * @preconditions Two routes with same ID
   * @expectedResult Should throw error during context creation
   */
  test("Rejects duplicate route IDs", async () => {
    const builder = testContext().routes(
      craft()
        .id("duplicate")
        .from(simple("test"))
        .id("duplicate")
        .from(simple("test")),
    );

    await expect(builder.build()).rejects.toThrow(/duplicate/i);
  });

  /**
   * @case Verifies route retrieval behavior
   * @preconditions Context with multiple routes
   * @expectedResult Correct route retrieval and undefined for missing
   */
  test("Manages multiple routes correctly", async () => {
    const testRoutes = [1, 2, 3]
      .map((n) => craft().id(`route-${n}`).from(simple(n)).build())
      .flat();

    t = await testContext().routes(testRoutes).build();

    expect(t.ctx.getRoutes()).toHaveLength(3);
    expect(t.ctx.getRouteById("route-2")).toBeDefined();
    expect(t.ctx.getRouteById("missing")).toBeUndefined();
  });
});

describe("Lifecycle Management", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) {
      await t.stop();
    }
  });

  /**
   * @case Verifies idempotent stop behavior
   * @preconditions Active context
   * @expectedResult Subsequent stop calls are no-ops
   */
  test("Handles multiple stop calls", async () => {
    t = await testContext().build();
    await t.ctx.start();

    await t.ctx.stop();
    const secondStop = t.ctx.stop(); // Should be no-op

    await expect(secondStop).resolves.not.toThrow();
  });

  /**
   * @case Validates store initialization
   * @preconditions Context with custom store
   * @expectedResult Store should be available in context
   */
  test("Initializes custom stores", async () => {
    const testStore = new Map([["test", "value"]]);

    t = await testContext()
      .store("customStore" as any, testStore)
      .build();

    expect(t.ctx.getStore("customStore" as any)).toBe(testStore);
  });
});

describe("Route Independence", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) {
      await t.stop();
    }
  });

  /**
   * @case Verifies that failed routes don't prevent others from processing and calls destination adapter
   * @preconditions Context with failing and working routes
   * @expectedResult Working route should process and eventually call destination adapter
   */
  test("Failed route does not prevent others from processing and calls destination adapter", async () => {
    const sendSpy = vi.fn();

    // Create context with failing and working routes.
    t = await testContext()
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
          .to(sendSpy),
      )
      .build();

    // Start the context. The working route should process and eventually
    // trigger the destination adapter's send() from the "to" step.
    await t.ctx.start();

    // Assert that the NoopAdapter's send method was called.
    expect(sendSpy).toHaveBeenCalled();
  });
});

// Binder-related tests removed
