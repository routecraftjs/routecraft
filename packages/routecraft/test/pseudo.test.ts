import { describe, test, expect, vi, expectTypeOf } from "vitest";
import {
  craft,
  simple,
  timer,
  log,
  pseudo,
  type RouteBuilder,
  type PseudoFactory,
  type PseudoKeyedFactory,
} from "../src/index.ts";
import type { Exchange } from "../src/exchange.ts";

// Option/result types for type-level and runtime tests
interface McpOpts {
  server: string;
  tool: string;
  args?: Record<string, unknown>;
}
interface UserData {
  id: string;
  name: string;
}
interface EnrichedData {
  data: string;
  extra: number;
}

function mockExchange<T = unknown>(body: T): Exchange<T> {
  return {
    id: "test-id",
    body,
    headers: {},
    logger: {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
    },
  } as Exchange<T>;
}

describe("Pseudo adapter", () => {
  describe("type-level compilation", () => {
    /**
     * @case Pseudo in .from() is accepted and RouteBuilder type is R
     * @preconditions pseudo factory and options
     * @expectedResult RouteBuilder<UserData>
     */
    test("from() with pseudo sets RouteBuilder<R>", () => {
      const src = pseudo<{ poll: number }>("src");
      const route = craft().from(src<UserData>({ poll: 1000 }));
      expectTypeOf(route).toEqualTypeOf<RouteBuilder<UserData>>();
    });

    /**
     * @case Pseudo in .enrich() is accepted and RouteBuilder type is R
     * @preconditions pseudo factory and options
     * @expectedResult RouteBuilder<EnrichedData>
     */
    test("enrich() with pseudo sets RouteBuilder<R>", () => {
      const mcp = pseudo<McpOpts>("mcp");
      const route = craft()
        .from(simple("hello"))
        .enrich(mcp<EnrichedData>({ server: "x", tool: "y" }));
      expectTypeOf(route).toEqualTypeOf<RouteBuilder<EnrichedData>>();
    });

    /**
     * @case Pseudo in .to() is accepted and RouteBuilder type is R
     * @preconditions pseudo factory and options
     * @expectedResult RouteBuilder<{ id: string }>
     */
    test("to() with pseudo sets RouteBuilder<R>", () => {
      const db = pseudo<{ table: string }>("db");
      const route = craft()
        .from(simple("data"))
        .to(db<{ id: string }>({ table: "events" }));
      expectTypeOf(route).toEqualTypeOf<RouteBuilder<{ id: string }>>();
    });

    /**
     * @case Pseudo in .tap() preserves current body type
     * @preconditions pseudo factory and options
     * @expectedResult RouteBuilder<{ count: number }>
     */
    test("tap() with pseudo preserves current type", () => {
      const metrics = pseudo<{ metric: string }>("metrics");
      const route = craft()
        .from(simple({ count: 1 }))
        .tap(metrics({ metric: "items" }));
      expectTypeOf(route).toEqualTypeOf<RouteBuilder<{ count: number }>>();
    });

    /**
     * @case Pseudo in .process() is accepted and RouteBuilder type is R
     * @preconditions pseudo factory and options
     * @expectedResult RouteBuilder<{ answer: string }>
     */
    test("process() with pseudo sets RouteBuilder<R>", () => {
      const ai = pseudo<{ model: string }>("ai");
      const route = craft()
        .from(simple("prompt"))
        .process(ai<{ answer: string }>({ model: "gpt-4" }));
      expectTypeOf(route).toEqualTypeOf<RouteBuilder<{ answer: string }>>();
    });

    /**
     * @case Chained pseudo enrich then split then to composes types
     * @preconditions mcp and db pseudo factories
     * @expectedResult RouteBuilder<{ id: string }>
     */
    test("chained pseudo adapters compose types correctly", () => {
      const mcp = pseudo<McpOpts>("mcp");
      const db = pseudo<{ table: string }>("db");
      const route = craft()
        .from(timer({ intervalMs: 1000 }))
        .enrich(mcp<{ messages: string[] }>({ server: "gmail", tool: "list" }))
        .split<string>((r) => r.messages)
        .to(db<{ id: string }>({ table: "emails" }));
      expectTypeOf(route).toEqualTypeOf<RouteBuilder<{ id: string }>>();
    });

    /**
     * @case pseudo(..., { args: 'keyed' }) return type
     * @preconditions keyed options
     * @expectedResult PseudoKeyedFactory<Opts>
     */
    test("keyed factory type is PseudoKeyedFactory", () => {
      const queue = pseudo<{ ttl: number }>("queue", { args: "keyed" });
      expectTypeOf(queue).toEqualTypeOf<PseudoKeyedFactory<{ ttl: number }>>();
    });

    /**
     * @case pseudo() default return type
     * @preconditions object-only call
     * @expectedResult PseudoFactory<Opts>
     */
    test("object factory type is PseudoFactory", () => {
      const mcp = pseudo<McpOpts>("mcp");
      expectTypeOf(mcp).toEqualTypeOf<PseudoFactory<McpOpts>>();
    });
  });

  describe("runtime behavior", () => {
    /**
     * @case Default runtime throws when send() is called
     * @preconditions pseudo with default options
     * @expectedResult Error message includes adapter name
     */
    test("default runtime throws with adapter name", () => {
      const mcp = pseudo<McpOpts>("mcp");
      const adapter = mcp({ server: "x", tool: "y" });
      expect(() => adapter.send(mockExchange("body"))).toThrow(
        /mcp.*not implemented/,
      );
    });

    /**
     * @case send and process both throw when not noop
     * @preconditions pseudo with default runtime
     * @expectedResult Both throw
     */
    test("throw applies to all interfaces (send, process)", () => {
      const p = pseudo("test-adapter");
      const adapter = p({});
      expect(() => adapter.send(mockExchange("x"))).toThrow();
      expect(() => adapter.process(mockExchange("x"))).toThrow();
    });

    /**
     * @case runtime 'noop' send() resolves without throwing
     * @preconditions pseudo with runtime: 'noop'
     * @expectedResult Promise resolves to undefined
     */
    test("noop runtime resolves without error", async () => {
      const mcp = pseudo<McpOpts>("mcp", { runtime: "noop" });
      const adapter = mcp({ server: "x", tool: "y" });
      await expect(
        Promise.resolve(adapter.send(mockExchange("x"))),
      ).resolves.toBeUndefined();
    });

    /**
     * @case When name is omitted, error message uses 'pseudo'
     * @preconditions pseudo() called with no name
     * @expectedResult Error matches /pseudo.*not implemented/
     */
    test("default name is 'pseudo' when no name given", () => {
      const p = pseudo();
      const adapter = p({});
      expect(() => adapter.send(mockExchange("x"))).toThrow(
        /pseudo.*not implemented/,
      );
    });

    /**
     * @case Each call to factory returns a new adapter object
     * @preconditions pseudo factory called twice
     * @expectedResult Two different references
     */
    test("each factory call returns a fresh adapter instance", () => {
      const mcp = pseudo<McpOpts>("mcp");
      const a = mcp({ server: "a", tool: "x" });
      const b = mcp({ server: "b", tool: "y" });
      expect(a).not.toBe(b);
    });
  });

  describe("overload resolution", () => {
    /**
     * @case Default overload returns factory that accepts options object
     * @preconditions pseudo<Opts>(name) without args keyed
     * @expectedResult Adapter has send, subscribe, process
     */
    test("object-only factory accepts options object", () => {
      const mcp = pseudo<{ server: string }>("mcp");
      const adapter = mcp({ server: "gmail" });
      expect(adapter).toHaveProperty("send");
      expect(adapter).toHaveProperty("subscribe");
      expect(adapter).toHaveProperty("process");
    });

    /**
     * @case Keyed overload returns factory that accepts (string, opts?)
     * @preconditions pseudo(..., { args: 'keyed' })
     * @expectedResult Adapter has send, subscribe, process
     */
    test("keyed factory accepts (string, opts?)", () => {
      const queue = pseudo<{ ttl: number }>("queue", { args: "keyed" });
      const adapter = queue("my-queue", { ttl: 5000 });
      expect(adapter).toHaveProperty("send");
      expect(adapter).toHaveProperty("subscribe");
      expect(adapter).toHaveProperty("process");
    });

    /**
     * @case Keyed factory second argument is optional
     * @preconditions pseudo(..., { args: 'keyed' }), call with key only
     * @expectedResult Adapter has send
     */
    test("keyed factory works without optional opts", () => {
      const queue = pseudo("queue", { args: "keyed" });
      const adapter = queue("my-queue");
      expect(adapter).toHaveProperty("send");
    });
  });

  describe("integration with route builder", () => {
    /**
     * @case Route with enrich, split, tap builds one definition with three steps
     * @preconditions craft().from(timer).enrich(mcp).split().tap(log())
     * @expectedResult One route, id and steps length match
     */
    test("pseudo adapter in enrich+split route builds valid definition", () => {
      const mcp = pseudo<McpOpts>("mcp");
      const route = craft()
        .id("pseudo-integration")
        .from(timer({ intervalMs: 1000, repeatCount: 1 }))
        .enrich(mcp<{ messages: string[] }>({ server: "gmail", tool: "list" }))
        .split<string>((r) => r.messages)
        .tap(log())
        .build();

      expect(route).toHaveLength(1);
      expect(route[0].id).toBe("pseudo-integration");
      expect(route[0].steps).toHaveLength(3); // enrich, split, tap
    });

    /**
     * @case Route with pseudo in .to() builds valid definition
     * @preconditions craft().from(simple).to(db)
     * @expectedResult One route, one step
     */
    test("pseudo adapter as destination builds valid definition", () => {
      const db = pseudo<{ table: string }>("db");
      const route = craft()
        .id("pseudo-to")
        .from(simple({ data: "test" }))
        .to(db<void>({ table: "events" }))
        .build();

      expect(route).toHaveLength(1);
      expect(route[0].steps).toHaveLength(1); // to
    });

    /**
     * @case Route with keyed pseudo in .to() builds valid definition
     * @preconditions craft().from(simple).to(queue('name', opts))
     * @expectedResult One route, one step
     */
    test("keyed pseudo adapter in to() builds valid definition", () => {
      const queue = pseudo<{ priority: number }>("queue", { args: "keyed" });
      const route = craft()
        .id("pseudo-keyed-to")
        .from(simple("message"))
        .to(queue<void>("outbound", { priority: 1 }))
        .build();

      expect(route).toHaveLength(1);
      expect(route[0].steps).toHaveLength(1);
    });
  });
});
