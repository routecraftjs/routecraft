import { describe, test, expect } from "vitest";
import { testContext } from "@routecraft/testing";
import { logger, DefaultExchange, craft, simple } from "@routecraft/routecraft";
import { childBindings } from "../src/logger.ts";

describe("logger", () => {
  /**
   * @case Logger exports a pino-like instance with level methods and child
   * @preconditions None
   * @expectedResult logger has info, debug, warn, error, trace, fatal, child as functions
   */
  test("logger is a pino-like instance with level methods and child", () => {
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.trace).toBe("function");
    expect(typeof logger.fatal).toBe("function");
    expect(typeof logger.child).toBe("function");
  });

  /**
   * @case logger.child returns a child logger with the same API
   * @preconditions None
   * @expectedResult child has info and child as functions
   */
  test("child returns a logger with the same API", () => {
    const child = logger.child({ contextId: "test-ctx" });
    expect(typeof child.info).toBe("function");
    expect(typeof child.child).toBe("function");
  });

  /**
   * @case childBindings for CraftContext returns contextId
   * @preconditions testContext with a route is built
   * @expectedResult bindings contain contextId matching ctx.contextId
   */
  test("childBindings for CraftContext returns contextId", async () => {
    const t = await testContext()
      .routes(craft().id("r").from(simple("x")))
      .build();
    const bindings = childBindings(t.ctx);
    expect(bindings).toHaveProperty("contextId", t.ctx.contextId);
  });

  /**
   * @case childBindings for Route returns contextId and routeId
   * @preconditions testContext with a named route is built
   * @expectedResult bindings contain contextId and routeId
   */
  test("childBindings for Route returns contextId and route", async () => {
    const t = await testContext()
      .routes(craft().id("my-route").from(simple("x")))
      .build();
    const route = t.ctx.getRoutes()[0];
    const bindings = childBindings(route);
    expect(bindings).toHaveProperty("contextId", t.ctx.contextId);
    expect(bindings).toHaveProperty("route", "my-route");
  });

  /**
   * @case childBindings for Exchange returns contextId, route, exchangeId, correlationId when exchange has internals
   * @preconditions DefaultExchange created with a context
   * @expectedResult bindings contain contextId, route, exchangeId, correlationId
   */
  test("childBindings for Exchange returns contextId, route, exchangeId, correlationId when exchange has internals", async () => {
    const t = await testContext()
      .routes(craft().id("r").from(simple("x")))
      .build();
    const ctx = t.ctx;
    const exchange = new DefaultExchange(ctx, { body: "test" });
    const bindings = childBindings(exchange);
    expect(bindings).toHaveProperty("contextId");
    expect(bindings).toHaveProperty("route");
    expect(bindings).toHaveProperty("exchangeId", exchange.id);
    expect(bindings).toHaveProperty("correlationId");
  });
});
