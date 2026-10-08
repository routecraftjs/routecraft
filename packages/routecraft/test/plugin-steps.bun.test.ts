import { afterEach, describe, expect, expectTypeOf, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  ContextBuilder,
  craft,
  definePlugin,
  defineProject,
  direct,
  noop,
  otherwise,
  port,
  step,
  when,
  type Body,
  type BodyOf,
  type Exchange,
} from "../src/index.ts";
import {
  continuationTailHash,
  describeSchema,
} from "../src/kernel/continuation/hash.ts";

interface Order {
  readonly id: string;
  readonly total: number;
}

/** Tags an order with a reference built from a caller-supplied key. */
const tagging = definePlugin({
  id: "test.tagging",
  steps: {
    stamp: (key: (body: Body) => string) =>
      step<Body, Body & { readonly ref: string }>((exchange) =>
        Object.assign({}, exchange.body, { ref: key(exchange.body) }),
      ),
  },
});

/** A step that only applies to orders: the method exists on an order route. */
const pricing = definePlugin({
  id: "test.pricing",
  steps: {
    withTax: (rate: number) =>
      step<Order, Order & { readonly gross: number }>((exchange) => ({
        ...exchange.body,
        gross: Math.round(exchange.body.total * (1 + rate)),
      })),
  },
});

/** Exposes the order's tenant from a header as `ex.tenant`. */
const tenant = definePlugin({
  id: "test.tenant",
  facet: (exchange: Exchange) => ({
    id: exchange.headers["x-tenant"] as string | undefined,
  }),
});

describe("plugin steps", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A plugin's step becomes a method on its project's builder and runs in the pipeline
   * @preconditions A project installing the pricing plugin; a route calls .withTax(0.21) on an order body
   * @expectedResult The caller receives the order with gross computed by the step, and the method is typed by the step's output
   */
  test("a project's craft() has its plugins' steps as methods", async () => {
    const project = defineProject({ plugins: [pricing] });
    const route = project
      .craft()
      .id("priced")
      .from<Order>(direct())
      .withTax(0.21);
    expectTypeOf<BodyOf<typeof route>>().toEqualTypeOf<
      Order & { readonly gross: number }
    >();

    t = await testContext()
      .with(project.config)
      .routes(route.to(noop()))
      .build();
    await t.startAndWaitReady();

    const result = await t.client.sendDirect("priced", {
      id: "o1",
      total: 100,
    });
    expect(result).toEqual({ id: "o1", total: 100, gross: 121 });
  });

  /**
   * @case A body-placeholder step is typed at the body the route has where the method is called
   * @preconditions The tagging plugin's step takes (body: Body) => string; a route calls it on an order body
   * @expectedResult The key function's parameter is the order, and the runtime adds ref
   */
  test("Body types a step at the call site", async () => {
    const project = defineProject({ plugins: [tagging] });
    const route = project
      .craft()
      .id("tagged")
      .from<Order>(direct())
      .stamp((order) => {
        expectTypeOf(order).toEqualTypeOf<Order>();
        return `ref-${order.id}`;
      });

    t = await testContext()
      .with(project.config)
      .routes(route.to(noop()))
      .build();
    await t.startAndWaitReady();

    const result = await t.client.sendDirect("tagged", { id: "o2", total: 5 });
    expect(result).toEqual({ id: "o2", total: 5, ref: "ref-o2" });
  });

  /**
   * @case A step whose input the route's body does not satisfy is not a method, and an uninstalled plugin's step is not either
   * @preconditions A project installing pricing (input Order); one route with a string body; deferral not configured
   * @expectedResult .withTax() on the string route and .defer() anywhere are compile errors
   */
  test("a step is a method only where it applies and only when installed", () => {
    const project = defineProject({ plugins: [pricing] });
    const stringRoute = project.craft().id("s").from<string>(direct());
    // Never called: the assertions are the compile errors.
    const typeOnly = () => {
      // @ts-expect-error withTax needs an Order body; this route carries a string
      stringRoute.withTax(0.1);
      // @ts-expect-error deferral is not configured in this project
      stringRoute.defer();
    };
    void typeOnly;

    const deferring = defineProject({ deferral: { store: "memory" } });
    expectTypeOf(
      deferring.craft().id("d").from<string>(direct()),
    ).toHaveProperty("defer");
  });

  /**
   * @case A misspelled config key is a compile error in defineProject, as in defineConfig
   * @preconditions defineProject called with an unknown key
   * @expectedResult The call does not compile
   */
  test("defineProject keeps excess-property checking", () => {
    const typeOnly = () =>
      // @ts-expect-error "deferal" is not a config key
      defineProject({ deferal: { store: "memory" } });
    void typeOnly;
  });

  /**
   * @case A branch inside .choice() has the same plugin steps as its route
   * @preconditions A project installing pricing; a choice whose branches both call .withTax() with different rates
   * @expectedResult Each branch's step runs with its own rate
   */
  test("a branch builder has the route's plugin steps", async () => {
    const project = defineProject({ plugins: [pricing] });
    const route = project
      .craft()
      .id("branchy")
      .from<Order>(direct())
      .choice<Order & { readonly gross: number }>(
        when(
          (ex) => ex.body.total > 50,
          (b) => b.withTax(0.5),
        ),
        otherwise((b) => b.withTax(0)),
      )
      .to(noop());

    t = await testContext().with(project.config).routes(route).build();
    await t.startAndWaitReady();

    expect(
      (await t.client.sendDirect("branchy", {
        id: "big",
        total: 100,
      })) as unknown,
    ).toEqual({ id: "big", total: 100, gross: 150 });
    expect(
      (await t.client.sendDirect("branchy", {
        id: "small",
        total: 10,
      })) as unknown,
    ).toEqual({ id: "small", total: 10, gross: 10 });
  });

  /**
   * @case A route using a step of a plugin its application does not install refuses to start
   * @preconditions A route built with a project that lists pricing, started in a context that does not install it
   * @expectedResult start() rejects with RC1111 naming test.pricing
   */
  test("a step whose plugin is not installed is RC1111 at start", async () => {
    const project = defineProject({ plugins: [pricing] });
    const route = project
      .craft()
      .id("orphan")
      .from<Order>(direct())
      .withTax(0.1)
      .to(noop());

    t = await testContext().routes(route).build();
    await expect(t.ctx.start()).rejects.toMatchObject({
      rc: "RC1111",
      message: expect.stringContaining('"test.pricing"'),
    });
  });

  /**
   * @case Two plugins declaring one step, or a step shadowing a builder method, are refused
   * @preconditions A project listing two plugins that both declare withTax; a plugin declaring a step named to
   * @expectedResult defineProject throws RC1116 for the first; craft() throws RC1116 for the second
   */
  test("step collisions are RC1116", () => {
    const again = definePlugin({
      id: "test.pricing-again",
      steps: { withTax: pricing.steps.withTax },
    });
    expect(() => defineProject({ plugins: [pricing, again] })).toThrow(
      expect.objectContaining({ rc: "RC1116" }),
    );

    const shadowing = definePlugin({
      id: "test.shadowing",
      steps: { to: () => step<Body, Body>((exchange) => exchange.body) },
    });
    const project = defineProject({ plugins: [shadowing] });
    expect(() => project.craft()).toThrow(
      expect.objectContaining({ rc: "RC1116" }),
    );
  });

  /**
   * @case A step named like a builder's own field rather than a method
   * @preconditions A plugin declaring a step named steps, which is a field of the branch builder rather than a prototype method
   * @expectedResult Building a branch throws RC1116 naming the plugin, not a raw TypeError from redefining the field
   */
  test("a step shadowing a builder field is RC1116", () => {
    const shadowing = definePlugin({
      id: "test.fields",
      steps: { steps: () => step<Body, Body>((exchange) => exchange.body) },
    });
    const project = defineProject({ plugins: [shadowing] });
    expect(() =>
      project
        .craft()
        .id("r")
        .from(direct())
        .choice(otherwise((b) => b)),
    ).toThrow(expect.objectContaining({ rc: "RC1116" }));
  });

  /**
   * @case A step factory that hands out one shared step object
   * @preconditions A plugin whose factory returns the same step on every call, used twice
   * @expectedResult The second use throws RC1116 naming the step and the plugin. The method labels and tags what the factory returns, so a shared object would carry one route's label into another and be claimed twice
   */
  test("a factory returning a step it already returned is RC1116", () => {
    const shared = step<Body, Body>((exchange) => exchange.body);
    const sharing = definePlugin({
      id: "test.shared",
      steps: { reuse: () => shared },
    });
    const project = defineProject({ plugins: [sharing] });
    const route = project.craft().id("r").from(direct()).reuse();
    expect(() => route.reuse()).toThrow(
      expect.objectContaining({
        rc: "RC1116",
        message: expect.stringContaining('"test.shared"'),
      }),
    );
  });
});

describe("plugin facets", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A plugin's facet is readable as ex.<namespace> in the project's routes, computed from the exchange
   * @preconditions A project installing the tenant plugin; a route reads ex.tenant.id from a header
   * @expectedResult The route returns the header's value through the facet, and the facet is typed
   */
  test("ex.<namespace> reads the plugin's facet", async () => {
    const project = defineProject({ plugins: [tenant] });
    const route = project
      .craft()
      .id("tenanted")
      .from(direct())
      .header("x-tenant", "acme")
      .transform((_body, ex) => {
        expectTypeOf(ex.tenant).toEqualTypeOf<{ id: string | undefined }>();
        return ex.tenant.id;
      })
      .to(noop());

    t = await testContext().with(project.config).routes(route).build();
    await t.startAndWaitReady();

    expect((await t.client.sendDirect("tenanted", "x")) as unknown).toBe(
      "acme",
    );
  });

  /**
   * @case An exchange of an application that does not install the plugin reads its facet
   * @preconditions One context installs tenant; a second context in the same process does not; both read ex.tenant
   * @expectedResult The first reads the facet; the second fails with RC1111, never reading the first application's facet and never handing a route an undefined to fail on later
   */
  test("a facet answers from the exchange's own application", async () => {
    let seen: unknown = "unset";
    const reader = craft()
      .id("reader")
      .from(direct())
      .process((ex) => {
        seen = (ex as unknown as { tenant?: unknown }).tenant;
        return ex;
      })
      .to(noop());

    const withTenant = await testContext()
      .with({ plugins: [tenant] })
      .routes(reader)
      .build();
    await withTenant.startAndWaitReady();
    await withTenant.client.sendDirect("reader", "x");
    expect(seen).toEqual({ id: undefined });
    await withTenant.stop();

    seen = "unset";
    t = await testContext().routes(reader).build();
    await t.startAndWaitReady();
    await expect(t.client.sendDirect("reader", "x")).rejects.toMatchObject({
      rc: "RC1111",
    });
    expect(seen).toBe("unset");
  });

  /**
   * @case A facet named after a field every exchange already has is refused
   * @preconditions A plugin with namespace "body" that declares a facet
   * @expectedResult The context build rejects with RC1114
   */
  test("a reserved facet name is RC1114", async () => {
    const clash = definePlugin({
      id: "test.clash",
      namespace: "body",
      facet: () => 1,
    });
    await expect(
      new ContextBuilder().with({ plugins: [clash] }).build(),
    ).rejects.toMatchObject({ rc: "RC1114" });
  });

  /**
   * @case A facet named `then`, which the language reads off every object
   * @preconditions A plugin with namespace "then" that declares a facet
   * @expectedResult The context build rejects with RC1114, so no exchange ever becomes a thenable
   */
  test("a facet named then is RC1114", async () => {
    const thenable = definePlugin({
      id: "test.thenable",
      namespace: "then",
      facet: () => 1,
    });
    await expect(
      new ContextBuilder().with({ plugins: [thenable] }).build(),
    ).rejects.toMatchObject({ rc: "RC1114" });
  });

  /**
   * @case A facet named `toJSON`, which JSON.stringify reads off every object
   * @preconditions A plugin with namespace "toJSON" that declares a facet
   * @expectedResult The context build rejects with RC1114, so serializing an exchange of another application can never hit the getter
   */
  test("a facet named toJSON is RC1114", async () => {
    const serializable = definePlugin({
      id: "test.serializable",
      namespace: "toJSON",
      facet: () => 1,
    });
    await expect(
      new ContextBuilder().with({ plugins: [serializable] }).build(),
    ).rejects.toMatchObject({ rc: "RC1114" });
  });

  /**
   * @case A listed plugin that only provides a port, beside one with steps
   * @preconditions A project installing pricing and a plugin with neither steps nor facet
   * @expectedResult pricing's method is still on the project's builder: a plugin contributing nothing hides nothing
   */
  test("a plugin without steps hides no other plugin's steps", () => {
    const PORT = port<{ readonly ok: boolean }>("test.nothing@1");
    const provider = definePlugin({
      id: "test.provider",
      provides: [PORT],
      bind(c) {
        c.provide(PORT, { ok: true });
      },
    });
    const project = defineProject({ plugins: [pricing, provider] });
    expectTypeOf(project.craft().id("p").from<Order>(direct())).toHaveProperty(
      "withTax",
    );
  });

  /**
   * @case A plugin brought through another plugin's installs
   * @preconditions A project listing only a plugin whose installs bring pricing
   * @expectedResult pricing's method is on the project's builder, as it is in the application's catalogue
   */
  test("a brought plugin's steps are typed on the project", () => {
    const bringing = definePlugin({ id: "test.bringing", installs: [pricing] });
    const project = defineProject({ plugins: [bringing] });
    expectTypeOf(project.craft().id("b").from<Order>(direct())).toHaveProperty(
      "withTax",
    );
  });

  /**
   * @case A listed plugin with a default plugin's id
   * @preconditions A project listing a plugin with the id routecraft.auth and no steps
   * @expectedResult .authenticate() is a compile error, since the application installs the listed plugin in the default's place
   */
  test("a listed plugin displaces the default of the same id", () => {
    const ownAuth = definePlugin({ id: "routecraft.auth" });
    const project = defineProject({ plugins: [ownAuth] });
    const route = project.craft().id("a").from<Order>(direct());
    // Never called: the assertion is the compile error.
    const typeOnly = () => {
      // @ts-expect-error the listed routecraft.auth displaces the default auth plugin and brings no authenticate step
      route.authenticate(() => undefined);
    };
    void typeOnly;
  });

  /**
   * @case ex.auth.principal reads the principal .authenticate() established
   * @preconditions A root craft() route authenticates a fixed subject then reads ex.auth.principal
   * @expectedResult The route returns the subject
   */
  test("ex.auth.principal is the auth plugin's facet", async () => {
    t = await testContext()
      .routes(
        craft()
          .id("whoami")
          .from(direct())
          .authenticate(() => ({ scheme: "test", subject: "ada" }))
          .transform((_body, ex) => ex.auth.principal?.subject)
          .to(noop()),
      )
      .build();
    await t.startAndWaitReady();

    expect((await t.client.sendDirect("whoami", "x")) as unknown).toBe("ada");
  });
});

describe("plugin step fingerprints", () => {
  /**
   * @case Two installs of one plugin step with different factory arguments
   * @preconditions Routes built with a project installing pricing, one calling .withTax(0.1) and one .withTax(0.2)
   * @expectedResult Their continuation hashes differ, so a cache or a deferred exchange built under one argument cannot be served under the other; the same argument hashes alike
   */
  test("a step's factory arguments are part of its fingerprint", () => {
    const { craft: build } = defineProject({ plugins: [pricing] });
    const tail = (rate: number) =>
      build()
        .id(`priced-${rate}`)
        .from<Order>(direct())
        .withTax(rate)
        .to(noop())
        .build()[0]!.steps;
    const schema = describeSchema();

    expect(continuationTailHash(tail(0.1), schema)).not.toBe(
      continuationTailHash(tail(0.2), schema),
    );
    expect(continuationTailHash(tail(0.1), schema)).toBe(
      continuationTailHash(tail(0.1), schema),
    );
  });

  /**
   * @case One plugin step called with undefined and with null
   * @preconditions A step factory accepting a nullable optional argument; routes calling it with undefined and with null
   * @expectedResult Their continuation hashes differ: the factory may act differently on the two, so a deferred approval under one must not resume under the other
   */
  test("undefined and null factory arguments are different fingerprints", () => {
    const rounding = definePlugin({
      id: "test.rounding",
      steps: {
        round: (mode: "up" | null | undefined) =>
          step<Order, Order>((exchange) => ({
            ...exchange.body,
            total:
              mode === "up"
                ? Math.ceil(exchange.body.total)
                : Math.round(exchange.body.total),
          })),
      },
    });
    const { craft: build } = defineProject({ plugins: [rounding] });
    const tail = (mode: "up" | null | undefined) =>
      build()
        .id("rounded")
        .from<Order>(direct())
        .round(mode)
        .to(noop())
        .build()[0]!.steps;
    const schema = describeSchema();

    expect(continuationTailHash(tail(undefined), schema)).not.toBe(
      continuationTailHash(tail(null), schema),
    );
  });
});
