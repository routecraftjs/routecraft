import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  MemoryDeferralStore,
  craft,
  direct,
  noop,
  recovery,
  type CraftContext,
  type ErrorHandler,
  type Exchange,
  type Route,
} from "../src/index.ts";
import { asDeferred } from "./helpers/deferral.ts";

const SECRET = "context-error-handler-test-secret-0123456789";

describe("context handlers: the error point", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case Registration returns an unregister function, the same shape ctx.on() returns
   * @preconditions A handler registered on a context, then unregistered
   * @expectedResult It decides while registered and stops being consulted after
   */
  test("registerErrorHandler returns an unregister function", async () => {
    const seen: string[] = [];
    t = await testContext()
      .routes([
        craft()
          .id("work")
          .from(direct())
          .transform(() => {
            throw new Error("boom");
          })
          .to(noop()),
      ])
      .build();
    const off = t.ctx.registerHandler("error", (error) => {
      seen.push("handler");
      return { recovered: (error as Error).message };
    });
    await t.startAndWaitReady();

    const first = (await t.client.sendDirect("work", {})) as {
      recovered: string;
    };
    expect(first.recovered).toBe("boom");
    expect(seen).toEqual(["handler"]);

    off();
    await expect(t.client.sendDirect("work", {})).rejects.toThrow("boom");
    // Not consulted again: the chain no longer holds it.
    expect(seen).toEqual(["handler"]);
  });

  /**
   * @case Registration order is consultation order and the first decision wins
   * @preconditions Three handlers, the first two passing with undefined
   * @expectedResult All three are consulted in order until one decides, and nothing after the decider runs
   */
  test("handlers run in registration order and the first non-undefined decides", async () => {
    const seen: string[] = [];
    t = await testContext()
      .routes([
        craft()
          .id("work")
          .from(direct())
          .transform(() => {
            throw new Error("boom");
          })
          .to(noop()),
      ])
      .build();
    t.ctx.registerHandler("error", () => {
      seen.push("first");
      return undefined;
    });
    t.ctx.registerHandler("error", () => {
      seen.push("second");
      return { by: "second" };
    });
    t.ctx.registerHandler("error", () => {
      seen.push("third");
      return { by: "third" };
    });
    await t.startAndWaitReady();

    const body = (await t.client.sendDirect("work", {})) as { by: string };

    expect(body.by).toBe("second");
    expect(seen).toEqual(["first", "second"]);
  });

  /**
   * @case The config field registers ahead of anything a plugin registers
   * @preconditions A handler in config and another registered by a plugin's apply()
   * @expectedResult The config handler is consulted first, because config applies first
   */
  test("CraftConfig.errorHandler is consulted before a plugin's handler", async () => {
    const seen: string[] = [];
    t = await testContext()
      .with({
        handlers: {
          error: () => {
            seen.push("config");
            return undefined;
          },
        },
        plugins: [
          {
            name: "late",
            apply(ctx: CraftContext) {
              ctx.registerHandler("error", () => {
                seen.push("plugin");
                return { by: "plugin" };
              });
            },
          },
        ],
      })
      .routes([
        craft()
          .id("work")
          .from(direct())
          .transform(() => {
            throw new Error("boom");
          })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    await t.client.sendDirect("work", {});

    expect(seen).toEqual(["config", "plugin"]);
  });

  /**
   * @case A route that handles its own failures is never overridden
   * @preconditions A route whose .error() recovers, and a context handler that would decide otherwise
   * @expectedResult The route's recovery stands and the context chain is never consulted
   */
  test("the route's own handler wins and the chain is not consulted", async () => {
    let consulted = 0;
    t = await testContext()
      .routes([
        craft()
          .id("work")
          .error(() => ({ by: "route" }))
          .from(direct())
          .transform(() => {
            throw new Error("boom");
          })
          .to(noop()),
      ])
      .build();
    t.ctx.registerHandler("error", () => {
      consulted += 1;
      return { by: "context" };
    });
    await t.startAndWaitReady();

    const body = (await t.client.sendDirect("work", {})) as { by: string };

    expect(body.by).toBe("route");
    expect(consulted).toBe(0);
  });

  /**
   * @case The chain is reached where the route's handler gave up
   * @preconditions A route whose .error() rethrows, and a context handler that recovers
   * @expectedResult The context handler decides, which is the case the chain exists for
   */
  test("a route handler that rethrows hands the failure to the chain", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("work")
          .error(() => recovery.rethrow())
          .from(direct())
          .transform(() => {
            throw new Error("boom");
          })
          .to(noop()),
      ])
      .build();
    t.ctx.registerHandler("error", () => ({ by: "context" }));
    await t.startAndWaitReady();

    const body = (await t.client.sendDirect("work", {})) as { by: string };
    expect(body.by).toBe("context");
  });

  /**
   * @case A handler receives the failing route and a forward bound to the failing exchange
   * @preconditions A handler forwarding to another route, on a route it can name
   * @expectedResult It is handed the route the failure belongs to, and the forward reaches its target
   */
  test("a handler receives the route and a forward bound to the failing exchange", async () => {
    let named: string | undefined;
    let forwarded: unknown;
    t = await testContext()
      .routes([
        craft()
          .id("work")
          .from(direct())
          .transform(() => {
            throw new Error("boom");
          })
          .to(noop()),
        craft()
          .id("report")
          .from(direct())
          .transform((body) => {
            forwarded = body;
            return body;
          })
          .to(noop()),
      ])
      .build();
    t.ctx.registerHandler(
      "error",
      async (_error, exchange: Exchange, forward, route: Route) => {
        named = route.definition.id;
        await forward("report" as never, { about: exchange.id });
        return { handled: true };
      },
    );
    await t.startAndWaitReady();

    await t.client.sendDirect("work", {});

    expect(named).toBe("work");
    expect(forwarded).toEqual({ about: expect.any(String) });
  });

  /**
   * @case A handler that throws does not take the chain down with it
   * @preconditions A first handler that throws and a second that recovers
   * @expectedResult The throw is reported with scope "context" and the chain continues to the second
   */
  test("a handler that throws is reported and the chain continues", async () => {
    const failures: Array<{ scope?: string; handlerIndex?: number }> = [];
    t = await testContext()
      .routes([
        craft()
          .id("work")
          .from(direct())
          .transform(() => {
            throw new Error("boom");
          })
          .to(noop()),
      ])
      .build();
    t.ctx.on("route:error-handler:failed", ({ details }) => {
      failures.push({
        ...(details.scope !== undefined ? { scope: details.scope } : {}),
        ...(details.handlerIndex !== undefined
          ? { handlerIndex: details.handlerIndex }
          : {}),
      });
    });
    t.ctx.registerHandler("error", () => {
      throw new Error("the handler itself broke");
    });
    t.ctx.registerHandler("error", () => ({ by: "second" }));
    await t.startAndWaitReady();

    const body = (await t.client.sendDirect("work", {})) as { by: string };

    expect(body.by).toBe("second");
    expect(failures).toEqual([{ scope: "context", handlerIndex: 0 }]);
  });

  /**
   * @case A chain that decides nothing leaves the original error to the failure path
   * @preconditions A single handler that throws, and no other handler
   * @expectedResult The step's own error reaches the caller, not the handler's
   */
  test("a handler's throw never replaces the error that reaches the failure path", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("work")
          .from(direct())
          .transform(() => {
            throw new Error("the original");
          })
          .to(noop()),
      ])
      .build();
    t.ctx.registerHandler("error", () => {
      throw new Error("the handler itself broke");
    });
    await t.startAndWaitReady();

    await expect(t.client.sendDirect("work", {})).rejects.toThrow(
      "the original",
    );
  });

  /**
   * @case A decided failure no longer reaches context:error or exchange:failed
   * @preconditions A handler that recovers, with both terminal events watched
   * @expectedResult Neither fires, which is the user-visible change this chain introduces
   */
  test("context:error and route:exchange:failed fire only when nothing decided", async () => {
    const fired: string[] = [];
    t = await testContext()
      .routes([
        craft()
          .id("work")
          .from(direct())
          .transform(() => {
            throw new Error("boom");
          })
          .to(noop()),
      ])
      .build();
    t.ctx.on("context:error", () => {
      fired.push("context:error");
    });
    t.ctx.on("route:exchange:failed", () => {
      fired.push("route:exchange:failed");
    });
    const off = t.ctx.registerHandler("error", () => ({ by: "context" }));
    await t.startAndWaitReady();

    await t.client.sendDirect("work", {});
    expect(fired).toEqual([]);

    // With nothing deciding, both fire exactly as they did before the chain
    // existed.
    off();
    await expect(t.client.sendDirect("work", {})).rejects.toThrow("boom");
    expect(fired).toEqual(["context:error", "route:exchange:failed"]);
  });

  /**
   * @case A handler can drop the exchange as well as recover it
   * @preconditions A handler answering recovery.drop
   * @expectedResult The exchange is dropped, with the reason on the drop event
   */
  test("a handler may drop the failing exchange", async () => {
    const dropped: string[] = [];
    t = await testContext()
      .routes([
        craft()
          .id("work")
          .from(direct())
          .transform(() => {
            throw new Error("boom");
          })
          .to(noop()),
      ])
      .build();
    t.ctx.on("route:exchange:dropped", ({ details }) => {
      dropped.push(details.reason);
    });
    t.ctx.registerHandler("error", () => recovery.drop("poison"));
    await t.startAndWaitReady();

    // A dropped exchange has no response body, so a request/reply caller is
    // told so rather than handed one: the same RC5031 a route .error() drop
    // produces.
    await expect(t.client.sendDirect("work", {})).rejects.toThrow(
      /dropped the exchange instead of completing it/,
    );
    expect(dropped).toEqual(["poison"]);
  });

  /**
   * @case A handler can park the exchange, which is the reason the chain exists
   * @preconditions A handler answering recovery.defer on a route that declares no defer site at all
   * @expectedResult The run answers with the Deferred acknowledgment and the record exists
   */
  test("a handler may park a route that declares no defer of its own", async () => {
    const store = new MemoryDeferralStore();
    t = await testContext()
      .with({ deferral: { store, secret: SECRET } })
      .routes([
        craft()
          .id("work")
          .from(direct())
          .transform(() => {
            throw new Error("needs a human");
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    t.ctx.registerHandler("error", () => recovery.defer({ ttl: "1h" }), {
      mayDefer: true,
    });
    await t.startAndWaitReady();

    const deferred = asDeferred(await t.client.sendDirect("work", {}));
    expect(await store.get(deferred.deferralId)).toBeDefined();
  });

  /**
   * @case A handler that may park makes the whole context require a runtime
   * @preconditions A deferring handler registered with no deferral runtime configured
   * @expectedResult start() fails with RC5052 naming the config line, rather than the first park failing
   */
  test("a deferring handler with no runtime fails the start with RC5052", async () => {
    t = await testContext()
      .routes([craft().id("work").from(direct()).to(noop())])
      .build();
    t.ctx.registerHandler("error", () => recovery.defer({ ttl: "1h" }), {
      mayDefer: true,
    });

    await expect(t.ctx.start()).rejects.toThrow(/RC5052|deferral runtime/);
  });

  /**
   * @case A handler that declares no parking leaves the boot check alone
   * @preconditions An ordinary handler registered with no deferral runtime
   * @expectedResult The context starts, because nothing in it can park
   */
  test("an ordinary handler does not make the context require a runtime", async () => {
    t = await testContext()
      .routes([craft().id("work").from(direct()).to(noop())])
      .build();
    t.ctx.registerHandler("error", () => undefined);

    await t.startAndWaitReady();
    expect(t.ctx.hasDeferringErrorHandler()).toBe(false);
  });

  /**
   * @case Unregistering the last deferring handler releases the requirement
   * @preconditions Two deferring handlers registered, then one unregistered
   * @expectedResult The context still reports it can park while the second holds it, and stops once both are gone
   */
  test("the deferring answer is held by a count, not a flag", async () => {
    t = await testContext()
      .with({ deferral: { store: new MemoryDeferralStore(), secret: SECRET } })
      .routes([craft().id("work").from(direct()).to(noop())])
      .build();
    const offFirst = t.ctx.registerHandler("error", () => undefined, {
      mayDefer: true,
    });
    const offSecond = t.ctx.registerHandler("error", () => undefined, {
      mayDefer: true,
    });

    expect(t.ctx.hasDeferringErrorHandler()).toBe(true);
    offFirst();
    expect(t.ctx.hasDeferringErrorHandler()).toBe(true);
    offSecond();
    expect(t.ctx.hasDeferringErrorHandler()).toBe(false);
  });

  /**
   * @case A park the framework refuses does not swallow the exchange's terminal event
   * @preconditions A context handler parking a failure raised inside a .split() fan-out, which RC5051 refuses
   * @expectedResult The refusal does not escape the executor: the exchange still reaches the ordinary failure path with the ORIGINAL error, and route:exchange:failed fires exactly once
   */
  test("a failed park still leaves exactly one terminal event", async () => {
    const terminals: string[] = [];
    // No deferral runtime, and the handler does not declare `mayDefer`, so
    // the boot check does not catch it: the park fails with RC5052 the first
    // time a failure reaches the handler. That is the misconfiguration this
    // guard exists to keep loud rather than swallow.
    t = await testContext()
      .routes([
        craft()
          .id("work")
          .from(direct())
          .transform(() => {
            throw new Error("the original");
          })
          .to(noop()),
      ])
      .build();
    for (const name of [
      "route:exchange:failed",
      "route:exchange:completed",
      "route:exchange:dropped",
      "route:exchange:deferred",
    ] as const) {
      t.ctx.on(name, () => {
        terminals.push(name);
      });
    }
    t.ctx.registerHandler("error", () => recovery.defer({ ttl: "1h" }));
    await t.startAndWaitReady();

    // The ORIGINAL failure reaches the caller, not the refusal of the
    // recovery attempted for it, and not nothing at all.
    await expect(t.client.sendDirect("work", {})).rejects.toThrow(
      "the original",
    );

    expect(terminals).toEqual(["route:exchange:failed"]);
  });

  /**
   * @case A route handler that throws its own error does not downgrade the park to an admission
   * @preconditions A route .error() that throws a fresh error, and a context handler that parks the result
   * @expectedResult The park lands at the step that actually failed, not at position 0 with the whole body as its continuation
   */
  test("a park after a route handler threw still lands at the failing step", async () => {
    const store = new MemoryDeferralStore();
    const ran: string[] = [];
    t = await testContext()
      .with({ deferral: { store, secret: SECRET } })
      .routes([
        craft()
          .id("work")
          .error(() => {
            // A fresh error the failing-step map has never seen. Inferring
            // the position from it alone would find nothing and read that
            // absence as "the failure came from outside the step tree".
            throw new Error("the compensation also failed");
          })
          .from(direct())
          .transform((body) => {
            ran.push("first");
            return body;
          })
          .transform(() => {
            throw new Error("needs a human");
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    t.ctx.registerHandler("error", () => recovery.defer({ ttl: "1h" }), {
      mayDefer: true,
    });
    await t.startAndWaitReady();

    const deferred = asDeferred(await t.client.sendDirect("work", {}));
    const record = await store.get(deferred.deferralId);

    expect(record?.errorPath?.origin).toBe("step");
    expect(record?.position).toBe(1);
    expect(ran).toEqual(["first"]);
  });

  /**
   * @case A selector by route id applies the handler to those routes and no others
   * @preconditions Two failing routes, with a handler registered for one of them by id
   * @expectedResult Only the named route is recovered; the other reaches the ordinary failure path
   */
  test("a selector matches by route id", async () => {
    const seen: string[] = [];
    t = await testContext()
      .routes([
        craft()
          .id("mine")
          .from(direct())
          .transform(() => {
            throw new Error("boom");
          })
          .to(noop()),
        craft()
          .id("theirs")
          .from(direct())
          .transform(() => {
            throw new Error("boom");
          })
          .to(noop()),
      ])
      .build();
    t.ctx.registerHandler(
      "error",
      (_error, _exchange, _forward, route: Route) => {
        seen.push(route.definition.id);
        return { by: "context" };
      },
      { routes: ["mine"] },
    );
    await t.startAndWaitReady();

    await t.client.sendDirect("mine", {});
    await expect(t.client.sendDirect("theirs", {})).rejects.toThrow("boom");

    // Not merely unrecovered: never consulted at all, which is the point of
    // a selector over an `if` at the top of the handler.
    expect(seen).toEqual(["mine"]);
  });

  /**
   * @case A selector by tag applies the handler to every route carrying it
   * @preconditions A tagged failing route and an untagged one
   * @expectedResult The tagged route is recovered and the untagged one is not
   */
  test("a selector matches by tag", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("gated")
          .tag("gated")
          .from(direct())
          .transform(() => {
            throw new Error("boom");
          })
          .to(noop()),
        craft()
          .id("open")
          .from(direct())
          .transform(() => {
            throw new Error("boom");
          })
          .to(noop()),
      ])
      .build();
    t.ctx.registerHandler("error", () => ({ by: "context" }), {
      tags: ["gated"],
    });
    await t.startAndWaitReady();

    const body = (await t.client.sendDirect("gated", {})) as { by: string };
    expect(body.by).toBe("context");
    await expect(t.client.sendDirect("open", {})).rejects.toThrow("boom");
  });

  /**
   * @case A selector carrying both keys names routes two ways rather than intersecting them
   * @preconditions A handler selecting one route by id and another by tag
   * @expectedResult Both are recovered, because routes and tags are alternatives
   */
  test("routes and tags in one selector are alternatives", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("by-id")
          .from(direct())
          .transform(() => {
            throw new Error("boom");
          })
          .to(noop()),
        craft()
          .id("by-tag")
          .tag("gated")
          .from(direct())
          .transform(() => {
            throw new Error("boom");
          })
          .to(noop()),
        craft()
          .id("neither")
          .from(direct())
          .transform(() => {
            throw new Error("boom");
          })
          .to(noop()),
      ])
      .build();
    t.ctx.registerHandler("error", () => ({ by: "context" }), {
      routes: ["by-id"],
      tags: ["gated"],
    });
    await t.startAndWaitReady();

    expect(await t.client.sendDirect<unknown, unknown>("by-id", {})).toEqual({
      by: "context",
    });
    expect(await t.client.sendDirect<unknown, unknown>("by-tag", {})).toEqual({
      by: "context",
    });
    await expect(t.client.sendDirect("neither", {})).rejects.toThrow("boom");
  });

  /**
   * @case A function written for the .error() operation is assignable to the error point unchanged
   * @preconditions One handler body used both as a route .error() and as a registered handler
   * @expectedResult Both compile and both decide, which is why the point is positional rather than context-shaped
   */
  test("an ErrorHandler body works at the error point unchanged", async () => {
    const handler: ErrorHandler = (error) => ({
      recovered: (error as Error).message,
    });

    t = await testContext()
      .routes([
        craft()
          .id("route-scope")
          .error(handler)
          .from(direct())
          .transform(() => {
            throw new Error("boom");
          })
          .to(noop()),
        craft()
          .id("context-scope")
          .from(direct())
          .transform(() => {
            throw new Error("boom");
          })
          .to(noop()),
      ])
      .build();
    // The same value, at the other ring. The point takes an extra `route`
    // parameter this body simply ignores.
    t.ctx.registerHandler("error", handler);
    await t.startAndWaitReady();

    expect(
      await t.client.sendDirect<unknown, unknown>("route-scope", {}),
    ).toEqual({ recovered: "boom" });
    expect(
      await t.client.sendDirect<unknown, unknown>("context-scope", {}),
    ).toEqual({ recovered: "boom" });
  });

  /**
   * @case A non-function registration is refused rather than failing at the first error
   * @preconditions registerErrorHandler called with something that is not a function
   * @expectedResult RC5003 naming the expected shape
   */
  test("a non-function handler is refused at registration", async () => {
    t = await testContext()
      .routes([craft().id("work").from(direct()).to(noop())])
      .build();

    expect(() =>
      t!.ctx.registerHandler("error", "not a handler" as never),
    ).toThrow(/registerHandler/);
  });
});
