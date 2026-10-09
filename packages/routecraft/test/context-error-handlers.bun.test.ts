import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  DefaultExchange,
  MemoryDeferralStore,
  craft,
  definePlugin,
  direct,
  noop,
  recovery,
  refuse,
  routeCanDefer,
  type ErrorHook,
  type HooksConfig,
  type Plugin,
  deferralOf,
} from "../src/index.ts";
import { asDeferred } from "./helpers/deferral.ts";

const SECRET = "context-error-handler-test-secret-0123456789";

/** A plugin carrying one or more hooks in the `error` slot. */
/** An error hook as a test writes it: the id defaults to its position. */
type LooseErrorHook = Omit<ErrorHook, "id"> & { readonly id?: string };

function errorPlugin(
  id: string,
  hooks: LooseErrorHook | LooseErrorHook[],
): Plugin {
  const named = (Array.isArray(hooks) ? hooks : [hooks]).map(
    (hook, index): ErrorHook => ({ id: `hook${index}`, ...hook }),
  );
  return definePlugin({ id, hooks: { error: named } });
}

/** A route on a direct endpoint whose only step throws `message`. */
function failing(id: string, message = "boom") {
  return craft()
    .id(id)
    .from(direct())
    .transform(() => {
      throw new Error(message);
    })
    .to(noop());
}

/**
 * The `error` slot: plugin hooks that hear every failure the route's own
 * `.error()` did not settle. `mutate` hooks decide (first answer wins,
 * `recovery.rethrow()` declines for the whole slot), `observe` hooks only
 * hear, and the order is the application's plugin list unless `hooks.order`
 * says otherwise.
 */
describe("the error slot", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case hooks.disable switches an error hook off without uninstalling its plugin
   * @preconditions Two plugins with a deciding error hook each; the first is disabled by id
   * @expectedResult The disabled hook is never consulted and the second decides; with only the disabled hook present, the failure reaches the caller
   */
  test("hooks.disable switches an error hook off", async () => {
    const seen: string[] = [];
    t = await testContext()
      .with({
        plugins: [
          errorPlugin("test.first", {
            id: "recover",
            phase: "mutate",
            run() {
              seen.push("first");
              return { by: "first" };
            },
          }),
          errorPlugin("test.second", {
            id: "recover",
            phase: "mutate",
            run() {
              seen.push("second");
              return { by: "second" };
            },
          }),
        ],
        hooks: { disable: ["test.first/recover"] },
      })
      .routes([failing("work")])
      .build();
    await t.startAndWaitReady();

    const body = (await t.client.sendDirect("work", {})) as { by: string };

    expect(body.by).toBe("second");
    expect(seen).toEqual(["second"]);
    await t.stop();

    seen.length = 0;
    t = await testContext()
      .with({
        plugins: [
          errorPlugin("test.first", {
            id: "recover",
            phase: "mutate",
            run() {
              seen.push("first");
              return { by: "first" };
            },
          }),
        ],
        hooks: { disable: ["test.first/recover"] },
      })
      .routes([failing("work")])
      .build();
    await t.startAndWaitReady();

    await expect(t.client.sendDirect("work", {})).rejects.toThrow("boom");
    expect(seen).toEqual([]);
  });

  /**
   * @case A hook names itself, because the application's config addresses it by that name
   * @preconditions An error hook declared without an id, bypassing the types as plain JavaScript would
   * @expectedResult The build fails with RC1117 naming the plugin and the slot, before any route runs
   */
  test("a hook without an id is refused at build with RC1117", async () => {
    await expect(
      testContext()
        .with({
          plugins: [
            definePlugin({
              id: "test.anonymous",
              hooks: {
                error: {
                  phase: "mutate",
                  run: () => ({ by: "hook" }),
                } as never,
              },
            }),
          ],
        })
        .build(),
    ).rejects.toMatchObject({
      rc: "RC1117",
      message: expect.stringContaining(
        'Plugin "test.anonymous" hook in "error" has no id',
      ),
    });
  });

  /**
   * @case Plugin list order is consultation order and the first decision wins
   * @preconditions Three plugins with a mutate error hook each, the first passing with undefined
   * @expectedResult They are consulted in list order until one decides, and nothing after the decider runs
   */
  test("hooks run in plugin list order and the first non-undefined decides", async () => {
    const seen: string[] = [];
    t = await testContext()
      .with({
        plugins: [
          errorPlugin("test.first", {
            phase: "mutate",
            run() {
              seen.push("first");
              return undefined;
            },
          }),
          errorPlugin("test.second", {
            phase: "mutate",
            run() {
              seen.push("second");
              return { by: "second" };
            },
          }),
          errorPlugin("test.third", {
            phase: "mutate",
            run() {
              seen.push("third");
              return { by: "third" };
            },
          }),
        ],
      })
      .routes([failing("work")])
      .build();
    await t.startAndWaitReady();

    const body = (await t.client.sendDirect("work", {})) as { by: string };

    expect(body.by).toBe("second");
    expect(seen).toEqual(["first", "second"]);
  });

  /**
   * @case The application overrides plugin list order with hooks.order
   * @preconditions Two plugins whose mutate error hooks both decide, listed a then b, with hooks.order naming b first
   * @expectedResult b is consulted first and decides; a is never consulted
   */
  test("hooks.order overrides plugin list order in the error slot", async () => {
    const seen: string[] = [];
    const hooks: HooksConfig = {
      order: { "error/mutate": ["test.b/decide"] },
    };
    t = await testContext()
      .with({
        plugins: [
          errorPlugin("test.a", {
            id: "decide",
            phase: "mutate",
            run() {
              seen.push("a");
              return { by: "a" };
            },
          }),
          errorPlugin("test.b", {
            id: "decide",
            phase: "mutate",
            run() {
              seen.push("b");
              return { by: "b" };
            },
          }),
        ],
        hooks,
      })
      .routes([failing("work")])
      .build();
    await t.startAndWaitReady();

    const body = (await t.client.sendDirect("work", {})) as { by: string };

    expect(body.by).toBe("b");
    expect(seen).toEqual(["b"]);
  });

  /**
   * @case An observe hook hears the failure but never decides it
   * @preconditions An observe hook listed before a mutate hook, and a second observe hook that wrongly returns a value
   * @expectedResult Both observe hooks hear the failure before the mutate hook runs; the returned value is reported, not taken as a decision, and the mutate hook decides
   */
  test("observe hooks hear the failure first and never decide", async () => {
    const seen: string[] = [];
    t = await testContext()
      .with({
        plugins: [
          errorPlugin("test.decider", {
            phase: "mutate",
            run() {
              seen.push("mutate");
              return { by: "mutate" };
            },
          }),
          errorPlugin("test.listener", [
            {
              id: "hear",
              phase: "observe",
              run(error) {
                seen.push(`observe:${(error as Error).message}`);
              },
            },
            {
              id: "talksBack",
              phase: "observe",
              run() {
                seen.push("observe:returns");
                return { by: "observer" };
              },
            },
          ]),
        ],
      })
      .routes([failing("work")])
      .build();
    await t.startAndWaitReady();

    const body = (await t.client.sendDirect("work", {})) as { by: string };

    expect(body.by).toBe("mutate");
    expect(seen).toEqual(["observe:boom", "observe:returns", "mutate"]);
  });

  /**
   * @case A route that handles its own failures is never overridden
   * @preconditions A route whose .error() recovers, and an error hook that would decide otherwise
   * @expectedResult The route's recovery stands and the slot is never consulted
   */
  test("the route's own handler wins and the slot is not consulted", async () => {
    let consulted = 0;
    t = await testContext()
      .with({
        plugins: [
          errorPlugin("test.ctx", {
            phase: "mutate",
            run() {
              consulted += 1;
              return { by: "context" };
            },
          }),
        ],
      })
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
    await t.startAndWaitReady();

    const body = (await t.client.sendDirect("work", {})) as { by: string };

    expect(body.by).toBe("route");
    expect(consulted).toBe(0);
  });

  /**
   * @case The slot is reached where the route's handler gave up
   * @preconditions A route whose .error() rethrows, and an error hook that recovers
   * @expectedResult The hook decides, which is the case the slot exists for
   */
  test("a route handler that rethrows hands the failure to the slot", async () => {
    t = await testContext()
      .with({
        plugins: [
          errorPlugin("test.ctx", {
            phase: "mutate",
            run: () => ({ by: "context" }),
          }),
        ],
      })
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
    await t.startAndWaitReady();

    const body = (await t.client.sendDirect("work", {})) as { by: string };
    expect(body.by).toBe("context");
  });

  /**
   * @case recovery.rethrow() from a hook declines for the whole slot
   * @preconditions A first mutate hook answering recovery.rethrow() and a second that would recover
   * @expectedResult The second is never consulted and the original error reaches the caller
   */
  test("recovery.rethrow() declines on behalf of every later hook", async () => {
    const seen: string[] = [];
    t = await testContext()
      .with({
        plugins: [
          errorPlugin("test.decline", {
            phase: "mutate",
            run() {
              seen.push("decline");
              return recovery.rethrow();
            },
          }),
          errorPlugin("test.recover", {
            phase: "mutate",
            run() {
              seen.push("recover");
              return { by: "recover" };
            },
          }),
        ],
      })
      .routes([failing("work")])
      .build();
    await t.startAndWaitReady();

    await expect(t.client.sendDirect("work", {})).rejects.toThrow("boom");
    expect(seen).toEqual(["decline"]);
  });

  /**
   * @case A hook learns the failing route and is handed a forward bound to the failing exchange
   * @preconditions A hook forwarding to another route
   * @expectedResult info names the route the failure belongs to, its run kind and slot, and the forward reaches its target
   */
  test("a hook receives the route and a forward bound to the failing exchange", async () => {
    let named: string | undefined;
    let slot: string | undefined;
    let kind: string | undefined;
    let forwarded: unknown;
    t = await testContext()
      .with({
        plugins: [
          errorPlugin("test.report", {
            phase: "mutate",
            async run(_error, exchange, info) {
              if (info.routeId !== "work") return undefined;
              named = info.routeId;
              slot = info.slot;
              kind = info.kind;
              await info.forward("report" as never, { about: exchange.id });
              return { handled: true };
            },
          }),
        ],
      })
      .routes([
        failing("work"),
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
    await t.startAndWaitReady();

    await t.client.sendDirect("work", {});

    expect(named).toBe("work");
    expect(slot).toBe("error");
    expect(kind).toBe("normal");
    expect(forwarded).toEqual({ about: expect.any(String) });
  });

  /**
   * @case A hook that throws does not take the slot down with it
   * @preconditions A first mutate hook that throws and a second that recovers
   * @expectedResult The throw is reported with scope "slot" naming the hook, and the slot continues to the second
   */
  test("a hook that throws is reported and the slot continues", async () => {
    const failures: Array<{ scope?: string; hook?: string }> = [];
    const invoked: Array<string | undefined> = [];
    t = await testContext()
      .with({
        plugins: [
          errorPlugin("test.broken", {
            phase: "mutate",
            run() {
              throw new Error("the hook itself broke");
            },
          }),
          errorPlugin("test.recover", {
            phase: "mutate",
            run: () => ({ by: "second" }),
          }),
        ],
      })
      .routes([failing("work")])
      .build();
    t.ctx.on("route:error-handler:failed", ({ details }) => {
      failures.push({
        ...(details.scope !== undefined ? { scope: details.scope } : {}),
        ...(details.hook !== undefined ? { hook: details.hook } : {}),
      });
    });
    t.ctx.on("route:error-handler:invoked", ({ details }) => {
      invoked.push(details.scope);
    });
    await t.startAndWaitReady();

    const body = (await t.client.sendDirect("work", {})) as { by: string };

    expect(body.by).toBe("second");
    expect(failures).toEqual([{ scope: "slot", hook: "test.broken/hook0" }]);
    expect(invoked).toEqual(["slot", "slot"]);
  });

  /**
   * @case A slot that decides nothing leaves the original error to the failure path
   * @preconditions A single mutate hook that throws, and no other hook
   * @expectedResult The step's own error reaches the caller, not the hook's
   */
  test("a hook's throw never replaces the error that reaches the failure path", async () => {
    t = await testContext()
      .with({
        plugins: [
          errorPlugin("test.broken", {
            phase: "mutate",
            run() {
              throw new Error("the hook itself broke");
            },
          }),
        ],
      })
      .routes([failing("work", "the original")])
      .build();
    await t.startAndWaitReady();

    await expect(t.client.sendDirect("work", {})).rejects.toThrow(
      "the original",
    );
  });

  /**
   * @case A decided failure no longer reaches context:error or exchange:failed
   * @preconditions A hook that recovers one route and passes on another, with both terminal events watched
   * @expectedResult Neither fires for the decided failure; both fire for the undecided one
   */
  test("context:error and route:exchange:failed fire only when nothing decided", async () => {
    const fired: string[] = [];
    t = await testContext()
      .with({
        plugins: [
          errorPlugin("test.ctx", {
            phase: "mutate",
            run: (_error, _exchange, info) =>
              info.routeId === "decided" ? { by: "context" } : undefined,
          }),
        ],
      })
      .routes([failing("decided"), failing("undecided")])
      .build();
    t.ctx.on("context:error", () => {
      fired.push("context:error");
    });
    t.ctx.on("route:exchange:failed", () => {
      fired.push("route:exchange:failed");
    });
    await t.startAndWaitReady();

    await t.client.sendDirect("decided", {});
    expect(fired).toEqual([]);

    await expect(t.client.sendDirect("undecided", {})).rejects.toThrow("boom");
    expect(fired).toEqual(["context:error", "route:exchange:failed"]);
  });

  /**
   * @case An error hook recovers a split child that is not the last one
   * @preconditions No route .error(); a plugin's error hook recovers with a body; three children, the first throws; an aggregate joins the children
   * @expectedResult The recovered child completes alone and never reaches the join; both siblings run and the join receives them; the parent completes
   */
  test("a hook's decision on a split child settles that child alone", async () => {
    const seen: number[] = [];
    const joined: unknown[] = [];
    const completed: string[] = [];
    let parentId: string | undefined;
    t = await testContext()
      .with({
        plugins: [
          errorPlugin("test.recover", {
            id: "recover",
            phase: "mutate",
            run: () => ({ recovered: true }),
          }),
        ],
      })
      .on("route:exchange:started", ({ details }) => {
        parentId ??= details.exchangeId;
      })
      .on("route:exchange:completed", ({ details }) => {
        completed.push(details.exchangeId);
      })
      .routes([
        craft()
          .id("fan")
          .from(direct())
          .split()
          .transform((n: unknown) => {
            if (n === 1) throw new Error("boom");
            seen.push(n as number);
            return n;
          })
          .aggregate()
          .tap((ex) => {
            joined.push(ex.body);
          })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    await t.client.sendDirect("fan", [1, 2, 3]);

    expect(seen).toEqual([2, 3]);
    expect(joined).toEqual([[2, 3]]);
    expect(completed).toContain(parentId as string);
    expect(completed).toHaveLength(4);
    expect(t.errors).toHaveLength(0);
  });

  /**
   * @case A hook can drop the exchange as well as recover it
   * @preconditions A hook answering recovery.drop
   * @expectedResult The exchange is dropped, with the reason on the drop event
   */
  test("a hook may drop the failing exchange", async () => {
    const dropped: string[] = [];
    t = await testContext()
      .with({
        plugins: [
          errorPlugin("test.drop", {
            phase: "mutate",
            run: () => recovery.drop("poison"),
          }),
        ],
      })
      .routes([failing("work")])
      .build();
    t.ctx.on("route:exchange:dropped", ({ details }) => {
      dropped.push(details.reason);
    });
    await t.startAndWaitReady();

    // A dropped exchange has no response body, so a request/reply caller is
    // told so: the same RC5031 a route .error() drop produces.
    await expect(t.client.sendDirect("work", {})).rejects.toThrow(
      /dropped the exchange instead of completing it/,
    );
    expect(dropped).toEqual(["poison"]);
  });

  /**
   * @case A hook can park the exchange, which is the reason the slot can defer
   * @preconditions A mayDefer hook answering recovery.defer on a route that declares no defer site
   * @expectedResult The run answers with the Deferred acknowledgment and the record exists
   */
  test("a hook may park a route that declares no defer of its own", async () => {
    const store = new MemoryDeferralStore();
    t = await testContext()
      .with({
        deferral: { store, secret: SECRET },
        plugins: [
          errorPlugin("test.park", {
            phase: "mutate",
            mayDefer: true,
            run: () => recovery.defer({ ttl: "1h" }),
          }),
        ],
      })
      .routes([
        failing("work", "needs a human"),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const deferred = asDeferred(await t.client.sendDirect("work", {}));
    expect(await store.get(deferred.deferralId)).toBeDefined();
  });

  /**
   * @case A hook that may park makes the whole context require a runtime
   * @preconditions A mayDefer error hook installed with no deferral runtime configured
   * @expectedResult start() fails with RC5052, rather than the first park failing
   */
  test("a mayDefer hook with no runtime fails the start with RC5052", async () => {
    t = await testContext()
      .with({
        plugins: [
          errorPlugin("test.park", {
            phase: "mutate",
            mayDefer: true,
            run: () => recovery.defer({ ttl: "1h" }),
          }),
        ],
      })
      .routes([craft().id("work").from(direct()).to(noop())])
      .build();

    await expect(t.ctx.start()).rejects.toMatchObject({ rc: "RC5052" });
  });

  /**
   * @case A hook that declares no parking leaves the boot check alone
   * @preconditions An ordinary error hook installed with no deferral runtime
   * @expectedResult The context starts, because nothing in it can park, and no route is advertised as deferrable
   */
  test("an ordinary hook does not make the context require a runtime", async () => {
    t = await testContext()
      .with({
        plugins: [
          errorPlugin("test.pass", { phase: "mutate", run: () => undefined }),
        ],
      })
      .routes([craft().id("work").from(direct()).to(noop())])
      .build();

    await t.startAndWaitReady();
    expect(t.ctx.hasDeferringErrorHook()).toBe(false);
    const route = t.ctx.getRoutes().find((r) => r.definition.id === "work")!;
    expect(routeCanDefer(route.definition, t.ctx)).toBe(false);
  });

  /**
   * @case mayDefer advertises every route as deferrable, and disabling the hook withdraws it
   * @preconditions A route with no defer site; once with a mayDefer hook installed, once with the same hook in hooks.disable
   * @expectedResult routeCanDefer is true while the hook is live and false once it is disabled, and the disabled hook no longer demands a runtime
   */
  test("mayDefer is read from the live hooks, so hooks.disable withdraws it", async () => {
    const park = errorPlugin("test.park", {
      id: "park",
      phase: "mutate",
      mayDefer: true,
      run: () => undefined,
    });

    t = await testContext()
      .with({
        deferral: { store: new MemoryDeferralStore(), secret: SECRET },
        plugins: [park],
      })
      .routes([craft().id("work").from(direct()).to(noop())])
      .build();
    let route = t.ctx.getRoutes().find((r) => r.definition.id === "work")!;
    expect(t.ctx.hasDeferringErrorHook()).toBe(true);
    expect(routeCanDefer(route.definition, t.ctx)).toBe(true);
    expect(routeCanDefer(route.definition)).toBe(false);
    await t.stop();

    t = await testContext()
      .with({ plugins: [park], hooks: { disable: ["test.park/park"] } })
      .routes([craft().id("work").from(direct()).to(noop())])
      .build();
    route = t.ctx.getRoutes().find((r) => r.definition.id === "work")!;
    expect(t.ctx.hasDeferringErrorHook()).toBe(false);
    expect(routeCanDefer(route.definition, t.ctx)).toBe(false);
    await t.startAndWaitReady();
  });

  /**
   * @case A park the framework refuses does not swallow the exchange's terminal event
   * @preconditions A hook that parks without declaring mayDefer, in a context with no deferral runtime, so the park itself fails with RC5052
   * @expectedResult The refusal does not escape the executor: the ORIGINAL error reaches the caller and route:exchange:failed fires exactly once
   */
  test("a failed park still leaves exactly one terminal event", async () => {
    const terminals: string[] = [];
    t = await testContext()
      .with({
        plugins: [
          errorPlugin("test.park", {
            phase: "mutate",
            run: () => recovery.defer({ ttl: "1h" }),
          }),
        ],
      })
      .routes([failing("work", "the original")])
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
    await t.startAndWaitReady();

    await expect(t.client.sendDirect("work", {})).rejects.toThrow(
      "the original",
    );

    expect(terminals).toEqual(["route:exchange:failed"]);
  });

  /**
   * @case A route handler that throws its own error does not downgrade the park to an admission
   * @preconditions A route .error() that throws a fresh error, and an error hook that parks the result
   * @expectedResult The park lands at the step that actually failed, not at position 0 with the whole body as its continuation
   */
  test("a park after a route handler threw still lands at the failing step", async () => {
    const store = new MemoryDeferralStore();
    const ran: string[] = [];
    t = await testContext()
      .with({
        deferral: { store, secret: SECRET },
        plugins: [
          errorPlugin("test.park", {
            phase: "mutate",
            mayDefer: true,
            run: () => recovery.defer({ ttl: "1h" }),
          }),
        ],
      })
      .routes([
        craft()
          .id("work")
          .error(() => {
            // A fresh error the failing-step map has never seen.
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
    await t.startAndWaitReady();

    const deferred = asDeferred(await t.client.sendDirect("work", {}));
    const record = await store.get(deferred.deferralId);

    expect(record?.errorPath?.origin).toBe("step");
    expect(record?.position).toBe(1);
    expect(ran).toEqual(["first"]);
  });

  /**
   * @case A hand-written route definition can still be parked by an error hook
   * @preconditions A RouteDefinition built as a literal rather than through craft().build(), and a deferring hook
   * @expectedResult It parks at the failing step, rather than being refused for having no resolved site
   */
  test("a definition that did not come from the builder still carries its park sites", async () => {
    const store = new MemoryDeferralStore();
    const [built] = craft()
      .id("work")
      .from(direct())
      // A step before the failing one, so the recorded position tells an
      // admission fallback (always 0) apart from the real failing step.
      .transform((body) => body)
      .transform(() => {
        throw new Error("needs a human");
      })
      .to(noop())
      .build();
    const raw = { ...built! };
    delete (raw as { errorPathSites?: unknown }).errorPathSites;
    delete (raw as { admissionSite?: unknown }).admissionSite;

    t = await testContext()
      .with({
        deferral: { store, secret: SECRET },
        plugins: [
          errorPlugin("test.park", {
            phase: "mutate",
            mayDefer: true,
            run: () => recovery.defer({ ttl: "1h" }),
          }),
        ],
      })
      .routes([raw as never, craft().id("answers").from(direct()).resume()])
      .build();
    await t.startAndWaitReady();

    const deferred = asDeferred(await t.client.sendDirect("work", {}));
    const record = await store.get(deferred.deferralId);
    expect(record?.errorPath?.origin).toBe("step");
    expect(record?.position).toBe(1);
  });

  /**
   * @case A hand-written definition keeps the resolver output both consumers read
   * @preconditions A RouteDefinition with a static .defer(), stripped of everything the builder resolved, registered on a context
   * @expectedResult deferSteps is restored, so the startup runtime check sees the route and a revival can find its static site
   */
  test("a definition that did not come from the builder keeps its defer steps", async () => {
    const store = new MemoryDeferralStore();
    const [built] = craft()
      .id("parks")
      .from(direct())
      .defer({})
      .to(noop())
      .build();
    const raw = { ...built! };
    delete (raw as { errorPathSites?: unknown }).errorPathSites;
    delete (raw as { admissionSite?: unknown }).admissionSite;
    delete (raw as { deferSteps?: unknown }).deferSteps;
    delete (raw as { reentrantDeferSteps?: unknown }).reentrantDeferSteps;
    delete (raw as { usesResume?: unknown }).usesResume;

    t = await testContext()
      .with({ deferral: { store, secret: SECRET } })
      .routes([raw as never, craft().id("answers").from(direct()).resume()])
      .build();
    await t.startAndWaitReady();

    const registered = t.ctx
      .getRoutes()
      .find((r) => r.definition.id === "parks");
    expect(registered?.definition.deferSteps?.length).toBe(1);
  });

  /**
   * @case A hand-written definition claiming defer steps its own steps do not support
   * @preconditions A route with no .defer(), handed over with deferSteps set by hand
   * @expectedResult The walk's answer replaces it, rather than being merged with it
   */
  test("a definition's own claim about its defer steps does not outrank the walk", async () => {
    const store = new MemoryDeferralStore();
    const [built] = craft()
      .id("claims")
      .from(direct())
      .transform((body) => body)
      .to(noop())
      .build();
    const raw = { ...built! } as Record<string, unknown>;
    delete raw["errorPathSites"];
    delete raw["admissionSite"];
    raw["deferSteps"] = [{ index: 0 }];
    raw["usesResume"] = true;

    t = await testContext()
      .with({ deferral: { store, secret: SECRET } })
      .routes([raw as never, craft().id("answers").from(direct()).resume()])
      .build();
    await t.startAndWaitReady();

    const registered = t.ctx
      .getRoutes()
      .find((r) => r.definition.id === "claims");
    expect(registered?.definition.deferSteps).toBeUndefined();
    expect(registered?.definition.usesResume).toBeUndefined();
  });

  /**
   * @case A forward out of a continuation does not make the target look like one
   * @preconditions A parked route whose continuation forwards to a second failing route, with a hook recording what each run reports
   * @expectedResult The target route runs as execution one, with no resume payload carried from the exchange that parked
   */
  test("deferral state does not travel through a forward into another route", async () => {
    const store = new MemoryDeferralStore();
    const seen: { route: string; execution: number; result: unknown }[] = [];
    t = await testContext()
      .with({
        deferral: { store, secret: SECRET },
        plugins: [
          errorPlugin("test.park", {
            phase: "mutate",
            mayDefer: true,
            async run(_error, exchange, info) {
              seen.push({
                route: info.routeId,
                execution: info.execution,
                result: deferralOf(exchange)?.result,
              });
              if (info.routeId === "downstream") return { done: true };
              if (info.execution === 1) return recovery.defer({ ttl: "1h" });
              await info.forward("downstream" as never, {
                from: "the continuation",
              });
              return { done: true };
            },
          }),
        ],
      })
      .routes([
        failing("work", "needs a human"),
        failing("downstream", "downstream is broken too"),
        craft()
          .id("answers")
          .from(direct())
          .resume((ex) => ({
            token: (ex.body as { token: string }).token,
            result: { approved: true },
          })),
      ])
      .build();
    await t.startAndWaitReady();

    const deferred = asDeferred(await t.client.sendDirect("work", {}));
    await t.client.sendDirect("answers", { token: deferred.token });

    expect(seen).toEqual([
      { route: "work", execution: 1, result: undefined },
      { route: "work", execution: 2, result: { approved: true } },
      { route: "downstream", execution: 1, result: undefined },
    ]);
  });

  /**
   * @case A resilience segment does not hand the error slot the route's turn
   * @preconditions A route with .retry(), its own .error(), and an error hook
   * @expectedResult The retry runs every attempt and the route's own handler decides; the hook is never consulted
   */
  test("an error hook does not pre-empt the route's handler inside a retry segment", async () => {
    const order: string[] = [];
    let attempts = 0;
    t = await testContext()
      .with({
        plugins: [
          errorPlugin("test.ctx", {
            phase: "mutate",
            run() {
              order.push("context");
              return { by: "context" };
            },
          }),
        ],
      })
      .routes([
        craft()
          .id("work")
          .retry({ maxAttempts: 3, backoff: 1 })
          .error(() => {
            order.push("route");
            return { by: "route" };
          })
          .from(direct())
          .transform(() => {
            attempts += 1;
            throw new Error("boom");
          })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    const result = await t.client.sendDirect("work", {});

    expect(result).toEqual({ by: "route" });
    expect(attempts).toBe(3);
    expect(order).toEqual(["route"]);
  });

  /**
   * @case A hook can tell a resumed continuation from the original run
   * @preconditions A step that fails on both executions, and a hook that parks on the first and recovers on the second
   * @expectedResult The hook sees execution 1 (kind normal) then 2 (kind resume), and the resumed failure is recovered rather than parked a second time
   */
  test("info.execution separates the continuation from the original run", async () => {
    const store = new MemoryDeferralStore();
    const executions: (1 | 2)[] = [];
    const kinds: string[] = [];
    t = await testContext()
      .with({
        deferral: { store, secret: SECRET },
        plugins: [
          errorPlugin("test.park", {
            phase: "mutate",
            mayDefer: true,
            routes: ["work"],
            run(_error, _exchange, info) {
              executions.push(info.execution);
              kinds.push(info.kind);
              return info.execution === 1
                ? recovery.defer({ ttl: "1h" })
                : { gaveUp: true };
            },
          }),
        ],
      })
      .routes([
        failing("work", "needs a human"),
        craft()
          .id("answers")
          .from(direct())
          .resume((ex) => ({
            token: (ex.body as { token: string }).token,
            result: { approved: true },
          })),
      ])
      .build();
    await t.startAndWaitReady();

    const deferred = asDeferred(await t.client.sendDirect("work", {}));
    const ack = (await t.client.sendDirect("answers", {
      token: deferred.token,
    })) as { continuation: { status: string; body?: unknown } };

    expect(executions).toEqual([1, 2]);
    expect(kinds).toEqual(["normal", "resume"]);
    expect(ack.continuation.status).toBe("completed");
    expect(ack.continuation.body).toEqual({ gaveUp: true });
  });

  /**
   * @case An error-channel re-entry runs as its own kind of run, below admission
   * @preconditions A plugin with a beforeAuth validate hook that refuses everything, an error hook narrowed to runs: ["errorChannel"] and one narrowed to runs: ["normal"]; the route's error channel entered directly, the way the sweeper retires an expired deferral
   * @expectedResult The admission hook never runs, the errorChannel hook hears the original failure with kind errorChannel, and the normal-only hook stays silent. A re-entry labelled normal would let an admission hook refuse a stored exchange and replace the expiry error, and would notify a normal-only hook twice for one failure
   */
  test("an error-channel re-entry skips admission hooks and reports its kind", async () => {
    const heard: string[] = [];
    let admissionRuns = 0;
    t = await testContext()
      .with({
        plugins: [
          definePlugin({
            id: "test.kinds",
            hooks: {
              beforeAuth: {
                id: "ingressOnly",
                phase: "validate",
                run: () => {
                  admissionRuns++;
                  return refuse("ingress only");
                },
              },
              error: [
                {
                  id: "channel",
                  phase: "observe",
                  runs: ["errorChannel"],
                  run: (error, _exchange, info) => {
                    heard.push(`${info.kind}:${(error as Error).message}`);
                  },
                },
                {
                  id: "normal",
                  phase: "observe",
                  runs: ["normal"],
                  run: () => {
                    heard.push("normal");
                  },
                },
              ],
            },
          }),
        ],
      })
      .routes([craft().id("work").from(direct()).to(noop())])
      .build();
    await t.startAndWaitReady();

    const route = t.ctx.getRoutes().find((r) => r.definition.id === "work")!;
    await route.enterErrorChannel(
      new DefaultExchange(t.ctx, { body: {} }),
      new Error("expired"),
      "expire",
    );

    expect(admissionRuns).toBe(0);
    expect(heard).toEqual(["errorChannel:expired"]);
  });

  /**
   * @case An error hook that names its run kinds is not consulted on the others
   * @preconditions A parked exchange whose continuation fails again; one hook parks with every run kind, a second declares runs: ["normal"]
   * @expectedResult The normal-only hook hears the first failure and not the resumed one, while the default hook hears both
   */
  test("runs narrows an error hook to the run kinds it names", async () => {
    const store = new MemoryDeferralStore();
    const heard: string[] = [];
    t = await testContext()
      .with({
        deferral: { store, secret: SECRET },
        plugins: [
          errorPlugin("test.normalOnly", {
            phase: "observe",
            runs: ["normal"],
            run(_error, _exchange, info) {
              heard.push(`normalOnly:${info.kind}`);
            },
          }),
          errorPlugin("test.park", {
            phase: "mutate",
            mayDefer: true,
            run(_error, _exchange, info) {
              heard.push(`every:${info.kind}`);
              return info.execution === 1
                ? recovery.defer({ ttl: "1h" })
                : { gaveUp: true };
            },
          }),
        ],
      })
      .routes([
        failing("work", "needs a human"),
        craft()
          .id("answers")
          .from(direct())
          .resume((ex) => ({
            token: (ex.body as { token: string }).token,
            result: { approved: true },
          })),
      ])
      .build();
    await t.startAndWaitReady();

    const deferred = asDeferred(await t.client.sendDirect("work", {}));
    await t.client.sendDirect("answers", { token: deferred.token });

    expect(heard).toEqual([
      "normalOnly:normal",
      "every:normal",
      "every:resume",
    ]);
  });

  /**
   * @case A selector by route id applies the hook to those routes and no others
   * @preconditions Two failing routes, with a hook selecting one of them by id
   * @expectedResult Only the named route is recovered; the other is never consulted and reaches the ordinary failure path
   */
  test("a selector matches by route id", async () => {
    const seen: string[] = [];
    t = await testContext()
      .with({
        plugins: [
          errorPlugin("test.mine", {
            phase: "mutate",
            routes: ["mine"],
            run(_error, _exchange, info) {
              seen.push(info.routeId);
              return { by: "context" };
            },
          }),
        ],
      })
      .routes([failing("mine"), failing("theirs")])
      .build();
    await t.startAndWaitReady();

    await t.client.sendDirect("mine", {});
    await expect(t.client.sendDirect("theirs", {})).rejects.toThrow("boom");

    expect(seen).toEqual(["mine"]);
  });

  /**
   * @case A selector by tag applies the hook to every route carrying it
   * @preconditions A tagged failing route and an untagged one
   * @expectedResult The tagged route is recovered and the untagged one is not
   */
  test("a selector matches by tag", async () => {
    t = await testContext()
      .with({
        plugins: [
          errorPlugin("test.gated", {
            phase: "mutate",
            tags: ["gated"],
            run: () => ({ by: "context" }),
          }),
        ],
      })
      .routes([
        craft()
          .id("gated")
          .tag("gated")
          .from(direct())
          .transform(() => {
            throw new Error("boom");
          })
          .to(noop()),
        failing("open"),
      ])
      .build();
    await t.startAndWaitReady();

    const body = (await t.client.sendDirect("gated", {})) as { by: string };
    expect(body.by).toBe("context");
    await expect(t.client.sendDirect("open", {})).rejects.toThrow("boom");
  });

  /**
   * @case A selector carrying both keys names routes two ways rather than intersecting them
   * @preconditions A hook selecting one route by id and another by tag
   * @expectedResult Both are recovered, because routes and tags are alternatives
   */
  test("routes and tags in one selector are alternatives", async () => {
    t = await testContext()
      .with({
        plugins: [
          errorPlugin("test.both", {
            phase: "mutate",
            routes: ["by-id"],
            tags: ["gated"],
            run: () => ({ by: "context" }),
          }),
        ],
      })
      .routes([
        failing("by-id"),
        craft()
          .id("by-tag")
          .tag("gated")
          .from(direct())
          .transform(() => {
            throw new Error("boom");
          })
          .to(noop()),
        failing("neither"),
      ])
      .build();
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
   * @case A malformed error hook is refused when the hooks are placed, not at the first failure
   * @preconditions One plugin whose error hook has no run function, another whose error hook declares the validate phase
   * @expectedResult Each build fails with RC1115
   */
  test("a malformed error hook is refused at build with RC1115", async () => {
    await expect(
      testContext()
        .with({
          plugins: [
            definePlugin({
              id: "test.norun",
              hooks: { error: { id: "norun", phase: "mutate" } as never },
            }),
          ],
        })
        .build(),
    ).rejects.toMatchObject({ rc: "RC1115" });

    await expect(
      testContext()
        .with({
          plugins: [
            definePlugin({
              id: "test.validates",
              hooks: {
                error: {
                  id: "validates",
                  phase: "validate",
                  run: () => undefined,
                } as never,
              },
            }),
          ],
        })
        .build(),
    ).rejects.toMatchObject({ rc: "RC1115" });
  });
});
