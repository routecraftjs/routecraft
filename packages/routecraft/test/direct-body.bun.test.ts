import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  direct,
  type Enricher,
  type Exchange,
  only,
} from "../src/index.ts";

/**
 * The proposed signature, spelled out so the case compiles today: an
 * enricher that calls `endpoint` with a body derived from the exchange.
 * Today's direct() ignores the second argument.
 */
const directWithBody = direct as unknown as <TIn, TOut>(
  endpoint: string,
  options: { body: (exchange: Exchange<TIn>) => unknown },
) => Enricher<TIn, TOut>;

/**
 * A route that calls an internal route as one step of its own, with a body
 * derived from the exchange: the callee takes a narrow request (an id), and
 * the caller holds a wider body it must keep. Today the caller's whole body
 * is what the callee receives, so composing internal routes means writing an
 * enricher that rewraps the exchange by hand.
 */
describe("direct() calling an internal route with a derived body", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    await t?.stop();
    t = undefined;
  });

  const lookup = craft()
    .id("lookup")
    .from(direct<{ id?: string; ref?: string }>({ internal: true }))
    .transform((body) => ({ received: body }));

  /**
   * @case A direct() enricher with no body option
   * @preconditions Route "caller" enriches through direct("lookup") with a
   *   body of { ref, note }
   * @expectedResult The callee receives the caller's whole body, as today
   */
  test("sends the caller's body when none is derived", async () => {
    t = await testContext()
      .routes([
        lookup,
        craft()
          .id("caller")
          .from(direct<{ ref: string; note: string }>())
          .enrich(
            direct<{ ref: string; note: string }, { received: unknown }>(
              "lookup",
            ),
            only((answer: { received: unknown }) => answer.received, "seen"),
          ),
      ])
      .build();
    await t.startAndWaitReady();

    const result = await t.client.sendDirect("caller", {
      ref: "a1",
      note: "kept",
    });

    expect(result).toEqual({
      ref: "a1",
      note: "kept",
      seen: { ref: "a1", note: "kept" },
    });
  });

  /**
   * @case A direct() enricher given a body derived from the exchange
   * @preconditions Route "caller" enriches through direct("lookup", { body })
   *   where body maps { ref, note } to { id: ref }
   * @expectedResult The callee receives only { id }, and the caller's body
   *   survives the enrich with the answer merged in. Fails today: the option
   *   is not part of direct(), so the callee receives the whole body.
   */
  test("sends the derived body and keeps the caller's", async () => {
    t = await testContext()
      .routes([
        lookup,
        craft()
          .id("caller")
          .from(direct<{ ref: string; note: string }>())
          .enrich(
            directWithBody<
              { ref: string; note: string },
              { received: unknown }
            >("lookup", { body: (exchange) => ({ id: exchange.body.ref }) }),
            only((answer: { received: unknown }) => answer.received, "seen"),
          ),
      ])
      .build();
    await t.startAndWaitReady();

    const result = await t.client.sendDirect("caller", {
      ref: "a1",
      note: "kept",
    });

    expect(result).toEqual({ ref: "a1", note: "kept", seen: { id: "a1" } });
  });
});
