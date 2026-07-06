import { afterEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, simple, direct } from "@routecraft/routecraft";

/**
 * `.input()` as a real filter-chain step (#447).
 *
 * Validation runs at pre-from chain position #4 for EVERY source shape:
 * inside the synthetic parse step when the source attaches a parser, and
 * as a standalone synthetic input step when it does not. Both paths throw
 * `RC5002` through the chain's catch boundary, so the route-scope
 * `.error()` handler (position #1) can observe and recover it, exactly
 * like `RC5012` / `RC5015` from `authorize` and `RC5016` from `parse`.
 * Before the fold, a parser-less source validated eagerly in the consumer
 * handler and bypassed `.error()` entirely.
 */
describe("Input validation in the filter chain (#447)", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case .error() recovers RC5002 from a parser-less source
   * @preconditions Route with .input() schema and a route-scope .error() handler returning a fallback; the simple() source attaches no parser and emits an invalid body
   * @expectedResult The handler observes RC5002 and the exchange completes with the fallback body (route-scope recovery resolves the exchange; remaining steps do not run), with no error escaping
   */
  test("no-parser source: .error() observes and recovers RC5002", async () => {
    let seenRc: string | undefined;
    const completed: unknown[] = [];

    t = await testContext()
      .on("route:exchange:completed", (p) => {
        completed.push(
          (p.details as { exchange?: { body?: unknown } }).exchange?.body,
        );
      })
      .routes(
        craft()
          .id("input-recover")
          .input({ body: z.object({ id: z.string() }) })
          .error((err) => {
            seenRc = (err as { rc?: string }).rc;
            return { id: "fallback" };
          })
          .from(simple({ id: 123 }))
          .to(mock()),
      )
      .build();

    await t.test();

    expect(seenRc).toBe("RC5002");
    expect(t.errors).toHaveLength(0);
    expect(completed).toEqual([{ id: "fallback" }]);
  });

  /**
   * @case .error() recovers RC5002 identically when the source attaches a parser
   * @preconditions Route with .input() schema and .error() fallback; a callable source emits a JSON string with a parse function, and the parsed body fails the schema
   * @expectedResult Same behaviour as the no-parser source: the handler observes RC5002 and the exchange completes with the fallback body
   */
  test("parser source: .error() observes and recovers RC5002", async () => {
    let seenRc: string | undefined;
    const completed: unknown[] = [];

    t = await testContext()
      .on("route:exchange:completed", (p) => {
        completed.push(
          (p.details as { exchange?: { body?: unknown } }).exchange?.body,
        );
      })
      .routes(
        craft()
          .id("input-recover-parsed")
          .input({ body: z.object({ id: z.string() }) })
          .error((err) => {
            seenRc = (err as { rc?: string }).rc;
            return { id: "fallback" };
          })
          .from((sub) => {
            void (async () => {
              sub.ready();
              await sub
                .emit({
                  message: '{"id":123}',
                  headers: {},
                  parse: (raw) => JSON.parse(raw as string),
                })
                .catch(() => {});
              sub.complete();
            })();
          })
          .to(mock()),
      )
      .build();

    await t.test();

    expect(seenRc).toBe("RC5002");
    expect(t.errors).toHaveLength(0);
    expect(completed).toEqual([{ id: "fallback" }]);
  });

  /**
   * @case Unrecovered validation failure takes the normal failure path, not a drop
   * @preconditions Route with .input() schema, no .error() handler, parser-less source with an invalid body
   * @expectedResult route:step:failed fires with operation "input", route:exchange:failed follows, and route:exchange:dropped never fires (the pre-#447 eager path emitted a drop instead)
   */
  test("unrecovered failure emits step:failed(input) + exchange:failed, no drop", async () => {
    const events: string[] = [];

    t = await testContext()
      .on("route:step:failed", (p) => {
        events.push(
          `step:failed:${(p.details as { operation?: string }).operation}`,
        );
      })
      .on("route:exchange:failed", () => {
        events.push("exchange:failed");
      })
      .on("route:exchange:dropped", () => {
        events.push("exchange:dropped");
      })
      .routes(
        craft()
          .id("input-fail-path")
          .input({ body: z.object({ id: z.string() }) })
          .from(simple({ id: 123 }))
          .to(mock()),
      )
      .build();

    await t.test();

    expect(t.errors).toHaveLength(1);
    expect(t.errors[0].rc).toBe("RC5002");
    expect(events).toContain("step:failed:input");
    expect(events).toContain("exchange:failed");
    expect(events).not.toContain("exchange:dropped");
  });

  /**
   * @case Cross-route recovery: the consumer's .error() shields the producer
   * @preconditions Producer sends an invalid body to a direct endpoint whose route has .input() plus an .error() fallback
   * @expectedResult The endpoint recovers, the producer's send resolves with the recovered result, and neither route errors
   */
  test("cross-route: consumer .error() recovery resolves the producer's send", async () => {
    const producerDest = mock();

    t = await testContext()
      .routes([
        craft()
          .id("producer")
          .from(simple({ id: 123 }))
          .to(direct("endpoint"))
          .to(producerDest),
        craft()
          .id("endpoint")
          .input({ body: z.object({ id: z.string() }) })
          .error((err) => {
            if ((err as { rc?: string }).rc === "RC5002") {
              return { id: "recovered" };
            }
            throw err;
          })
          .from(direct())
          .to(mock()),
      ])
      .build();

    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(producerDest).toHaveBeenCalledTimes(1);
    expect(producerDest.mock.calls[0][0].body).toEqual({ id: "recovered" });
  });

  /**
   * @case Schema coercion still reaches the pipeline on the chain path
   * @preconditions Route with a coercing .input() schema and a parser-less source
   * @expectedResult The destination receives the coerced body, proving the standalone input step rewraps like the old eager path did
   */
  test("coerced values flow through the standalone input step", async () => {
    const consumer = mock();

    t = await testContext()
      .routes(
        craft()
          .id("input-coerce")
          .input({ body: z.object({ count: z.coerce.number() }) })
          .from(simple({ count: "42" }))
          .to(consumer),
      )
      .build();

    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer.mock.calls[0][0].body).toEqual({ count: 42 });
  });
});
