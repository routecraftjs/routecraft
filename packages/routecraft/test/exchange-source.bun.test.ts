import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  definePlugin,
  direct,
  HeadersKeys,
  noop,
  simple,
  sourceOf,
  type Exchange,
  type Hooks,
  type Source,
} from "../src/index.ts";
import { asDeferred, deferring } from "./helpers/deferral.ts";

const SIMPLE = "routecraft.adapter.simple";
const DIRECT = "routecraft.adapter.direct";

/** A plugin whose `admitted` observe hook records the body of every exchange its `sources` admit. */
function watching(sources: readonly string[], seen: unknown[]) {
  return definePlugin({
    id: "test.watcher",
    hooks: {
      admitted: {
        id: "watch",
        phase: "observe",
        sources,
        run: (exchange) => {
          seen.push(exchange.body);
        },
      },
    },
  });
}

describe("exchange source", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case sourceOf() names the adapter that admitted the exchange
   * @preconditions One route fed by simple(), one fed by a hand-written source with no adapterId
   * @expectedResult The first reads "routecraft.adapter.simple", the second "inline"
   */
  test("names the admitting adapter, and inline for a source without an id", async () => {
    const seen: Record<string, string | undefined> = {};
    const bare: Source<string> = {
      subscribe: async (sub) => {
        await sub.emit({ message: "b" });
      },
    };
    t = await testContext()
      .routes([
        craft()
          .id("adapter")
          .from(simple("a"))
          .tap((ex) => {
            seen["adapter"] = sourceOf(ex);
          })
          .to(noop()),
        craft()
          .id("bare")
          .from(bare)
          .tap((ex) => {
            seen["bare"] = sourceOf(ex);
          })
          .to(noop()),
      ])
      .build();
    await t.test();
    expect(seen).toEqual({ adapter: SIMPLE, bare: "inline" });
  });

  /**
   * @case A source cannot claim to be another source
   * @preconditions A hand-written source emitting a routecraft.source header naming argv
   * @expectedResult The exchange reads "inline": the engine stamps the header at every ingress, over whatever arrived
   */
  test("overwrites a source header the adapter supplied", async () => {
    let seen: string | undefined;
    const forging: Source<string> = {
      subscribe: async (sub) => {
        await sub.emit({
          message: "x",
          headers: { [HeadersKeys.SOURCE]: "routecraft.adapter.argv" },
        });
      },
    };
    t = await testContext()
      .routes(
        craft()
          .id("forged")
          .from(forging)
          .tap((ex) => {
            seen = sourceOf(ex);
          })
          .to(noop()),
      )
      .build();
    await t.test();
    expect(seen).toBe("inline");
  });

  /**
   * @case A hand-off to another route is a new admission
   * @preconditions A simple() route sending to a second route through direct()
   * @expectedResult The first route reads the simple id, the second the direct id
   */
  test("re-stamps on a hop through direct()", async () => {
    const seen: string[] = [];
    t = await testContext()
      .routes([
        craft()
          .id("first")
          .from(simple("a"))
          .tap((ex) => {
            seen.push(`first:${sourceOf(ex)}`);
          })
          .to(direct("second")),
        craft()
          .id("second")
          .from(direct())
          .tap((ex) => {
            seen.push(`second:${sourceOf(ex)}`);
          })
          .to(noop()),
      ])
      .build();
    await t.test();
    expect(seen).toEqual([`first:${SIMPLE}`, `second:${DIRECT}`]);
  });

  /**
   * @case Split children inherit the parent's source
   * @preconditions simple() emitting one array, split into two children
   * @expectedResult Both children read the simple id
   */
  test("split children keep the source", async () => {
    const seen: Array<string | undefined> = [];
    t = await testContext()
      .routes(
        craft()
          .id("fan")
          .from(simple([[1, 2]]))
          .split()
          .tap((ex) => {
            seen.push(sourceOf(ex));
          })
          .to(noop()),
      )
      .build();
    await t.test();
    expect(seen).toEqual([SIMPLE, SIMPLE]);
  });

  /**
   * @case A step that returns its own headers cannot rename the source
   * @preconditions .process(), an .enrich() aggregator and an .aggregate() aggregator each return a forged routecraft.source; an exit hook is scoped to the forged name
   * @expectedResult sourceOf() still reads the admitting adapter after each step, and the hook never runs
   */
  test("process, enrich and aggregate cannot forge the source", async () => {
    const FORGED = "routecraft.adapter.argv";
    const forge = <T extends { headers: Record<string, unknown> }>(ex: T) => ({
      ...ex.headers,
      [HeadersKeys.SOURCE]: FORGED,
    });
    const seen: Record<string, string | undefined> = {};
    const hooked: unknown[] = [];
    t = await testContext()
      .with({
        plugins: [
          definePlugin({
            id: "test.exit-watcher",
            hooks: {
              exit: {
                id: "watch",
                phase: "observe",
                sources: [FORGED],
                run: (exchange) => {
                  hooked.push(exchange.body);
                },
              },
            },
          }),
        ],
      })
      .routes([
        craft()
          .id("process")
          .from(simple("a"))
          .process((ex) => ({ ...ex, headers: forge(ex) }))
          .tap((ex) => {
            seen["process"] = sourceOf(ex);
          })
          .to(noop()),
        craft()
          .id("enrich")
          .from(simple("a"))
          .enrich(
            () => "extra",
            (ex: Exchange<string>) => ({ ...ex, headers: forge(ex) }),
          )
          .tap((ex) => {
            seen["enrich"] = sourceOf(ex);
          })
          .to(noop()),
        craft()
          .id("aggregate")
          .from(simple(["a", "b"]))
          .split()
          .aggregate((exchanges) => ({
            body: exchanges.length,
            headers: forge(exchanges[0]!),
          }))
          .tap((ex) => {
            seen["aggregate"] = sourceOf(ex);
          })
          .to(noop()),
      ])
      .build();
    await t.test();

    expect(seen).toEqual({
      process: SIMPLE,
      enrich: SIMPLE,
      aggregate: SIMPLE,
    });
    expect(hooked).toEqual([]);
  });

  /**
   * @case A route cannot write the source header
   * @preconditions .header("routecraft.source", ...) on a route
   * @expectedResult Building the route fails with RC5003, the engine-owned header contract
   */
  test(".header() on the source header is refused", () => {
    expect(() =>
      craft().id("writer").from(simple("a")).header(HeadersKeys.SOURCE, "x"),
    ).toThrow(expect.objectContaining({ rc: "RC5003" }));
  });

  /**
   * @case A hook's sources selector narrows it to exchanges from those sources
   * @preconditions One route with simple() and direct(); an admitted observe hook with sources naming direct only
   * @expectedResult The hook sees the direct call and not the simple emission
   */
  test("a hook with sources runs only for those sources", async () => {
    const seen: unknown[] = [];
    t = await testContext()
      .with({ plugins: [watching([DIRECT], seen)] })
      .routes(
        craft()
          .id("both")
          .input({ body: z.string() })
          .from(simple("from-simple"), direct())
          .to(noop()),
      )
      .build();
    await t.startAndWaitReady();
    await t.client.sendDirect("both", "from-direct");
    expect(seen).toEqual(["from-direct"]);
  });

  /**
   * @case A sources selector that can never match, or sits where no exchange exists, fails the build
   * @preconditions One plugin with sources: [], one with sources on a perAttempt wrapper
   * @expectedResult Each build fails with RC1115
   */
  test("an empty sources list and sources in perAttempt fail with RC1115", async () => {
    const build = (hooks: Hooks) =>
      testContext()
        .with({ plugins: [definePlugin({ id: "test.bad", hooks })] })
        .routes(craft().id("r").from(simple("a")).to(noop()))
        .build();
    await expect(
      build({
        admitted: { id: "a", phase: "observe", sources: [], run: () => {} },
      }),
    ).rejects.toMatchObject({ rc: "RC1115" });
    await expect(
      build({
        perAttempt: {
          id: "w",
          sources: [SIMPLE],
          wrap: (next: unknown) => next,
        } as never,
      }),
    ).rejects.toMatchObject({ rc: "RC1115" });
  });

  /**
   * @case route:exchange:started carries the source
   * @preconditions A simple() route with a listener on the started event
   * @expectedResult The event details name the simple id
   */
  test("the started event names the source", async () => {
    const sources: Array<string | undefined> = [];
    t = await testContext()
      .on("route:exchange:started", ({ details }) => {
        sources.push(details.source);
      })
      .routes(craft().id("ev").from(simple("a")).to(noop()))
      .build();
    await t.test();
    expect(sources).toEqual([SIMPLE]);
  });

  /**
   * @case A resumed exchange keeps the source it was first admitted through
   * @preconditions A payout route admitted through direct() that defers; the resume arrives through a route fed by a hand-written source
   * @expectedResult The step after the defer reads the direct id, not "inline", the source of the door that carried the resume
   */
  test("a resumed exchange keeps its first source", async () => {
    let after: string | undefined;
    let answer: ((body: unknown) => Promise<unknown>) | undefined;
    const door: Source<unknown> = {
      subscribe: async (sub) => {
        answer = (body) => sub.emit({ message: body });
        sub.ready();
        await new Promise<void>((resolve) =>
          sub.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    };
    t = await testContext()
      .with(deferring())
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .defer({ input: z.object({ approved: z.boolean() }) })
          .tap((ex) => {
            after = sourceOf(ex);
          })
          .to(noop()),
        craft().id("answers").from(door).resume(),
      ])
      .build();
    await t.startAndWaitReady();
    const deferred = asDeferred(
      await t.client.sendDirect("payout", { amountCents: 1 }),
    );
    await answer?.({ token: deferred.token, input: { approved: true } });
    expect(after).toBe(DIRECT);
  });
});
