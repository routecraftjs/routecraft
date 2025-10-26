import { describe, test, expect } from "vitest";
import {
  craft,
  simple,
  BatchConsumer,
  type RouteDefinition,
} from "@routecraft/routecraft";

describe("Route and Wrapper semantics - ordering", () => {
  /**
   * @case id() stages the identifier for the next route and does not rename the current route
   * @preconditions No routes created before first id(); call id() again after first from()
   * @expectedResult First route keeps first id; second route gets second id
   */
  test("stages id for next route (does not rename current)", () => {
    const defs: RouteDefinition[] = craft()
      .id("route-1")
      .from(simple("a"))
      // This id() should apply to the NEXT route, not rename the current
      .id("route-2")
      .from(simple("b"))
      .build();

    expect(defs).toHaveLength(2);
    expect(defs[0].id).toBe("route-1");
    expect(defs[1].id).toBe("route-2");
  });

  /**
   * @case batch() config applies to the next route and is cleared for subsequent routes
   * @preconditions Stage batch() before first from(); do not stage before second from()
   * @expectedResult First route uses BatchConsumer with mapped options; second uses SimpleConsumer
   */
  test("batch applies to entire next route and is cleared afterwards", () => {
    const defs: RouteDefinition[] = craft()
      .batch({ size: 5, flushIntervalMs: 2000 })
      .id("batched")
      .from(simple("x"))
      // No batch staged here, so second route should use SimpleConsumer
      .id("simple")
      .from(simple("y"))
      .build();

    expect(defs).toHaveLength(2);
    expect(defs[0].id).toBe("batched");
    expect(defs[0].consumer.type).toBe(BatchConsumer as any);
    const opts = defs[0].consumer.options as any;
    expect(opts.size).toBe(5);
    expect(opts.time).toBe(2000); // mapped from flushIntervalMs

    expect(defs[1].id).toBe("simple");
    // Should not be BatchConsumer on the second route
    expect(defs[1].consumer.type).not.toBe(BatchConsumer as any);
  });

  /**
   * @case batch() staged after a route affects only the following route
   * @preconditions Create first route, then call batch() and set id for next route
   * @expectedResult First route remains non-batch; second route uses BatchConsumer
   */
  test("batch staged after a route only affects the subsequent route", () => {
    const defs: RouteDefinition[] = craft()
      .id("first")
      .from(simple("one"))
      // Stage batch here, should not affect the first route
      .batch({ size: 7 })
      .id("second")
      .from(simple("two"))
      .build();

    expect(defs).toHaveLength(2);
    // First remains non-batch
    expect(defs[0].id).toBe("first");
    expect(defs[0].consumer.type).not.toBe(BatchConsumer as any);
    // Second gets batch
    expect(defs[1].id).toBe("second");
    expect(defs[1].consumer.type).toBe(BatchConsumer as any);
    const opts = defs[1].consumer.options as any;
    expect(opts.size).toBe(7);
  });
});
