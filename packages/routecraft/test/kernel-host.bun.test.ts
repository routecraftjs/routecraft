import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  ContextBuilder,
  craft,
  definePlugin,
  direct,
  noop,
  port,
  type Plugin,
} from "../src/index.ts";

interface Store {
  readonly kind: string;
}

const STORE = port<Store>("test.store@1");

/** Build a context from plugins and return the error its build refused with. */
async function refusal(plugins: Plugin[]): Promise<unknown> {
  try {
    await new ContextBuilder().with({ plugins }).build();
  } catch (error) {
    return error;
  }
  throw new Error("the build did not refuse");
}

/**
 * The kernel host: identity, resolution, order, bind and freeze. Everything
 * that can go wrong on the way to running refuses before any traffic, with
 * a code and the plugin responsible.
 */
describe("the kernel host", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A consumer listed before its provider still binds after it
   * @preconditions "consumer" requires a port that "provider" provides, and is listed first
   * @expectedResult bind order is provider then consumer, and the consumer reads the provided value
   */
  test("orders plugins by what they require", async () => {
    const order: string[] = [];
    let seen: Store | undefined;
    const consumer = definePlugin({
      id: "test.consumer",
      requires: [STORE],
      bind(c) {
        order.push("consumer");
        seen = c.require(STORE);
      },
    });
    const provider = definePlugin({
      id: "test.provider",
      provides: [STORE],
      bind(c) {
        order.push("provider");
        c.provide(STORE, { kind: "memory" });
      },
    });

    t = await testContext()
      .with({ plugins: [consumer, provider] })
      .build();

    expect(order).toEqual(["provider", "consumer"]);
    expect(seen).toEqual({ kind: "memory" });
    expect(t.ctx.require(STORE)).toEqual({ kind: "memory" });
  });

  /**
   * @case Plugins with no dependency between them keep the order they were listed in
   * @preconditions Three independent plugins
   * @expectedResult They bind in list order
   */
  test("keeps list order where dependencies allow", async () => {
    const order: string[] = [];
    const named = (id: string) =>
      definePlugin({
        id,
        bind() {
          order.push(id);
        },
      });
    t = await testContext()
      .with({
        plugins: [
          named("test.third"),
          named("test.first"),
          named("test.second"),
        ],
      })
      .build();
    expect(order).toEqual(["test.third", "test.first", "test.second"]);
  });

  /**
   * @case Two plugins share an id
   * @preconditions Two descriptors with the id "test.same"
   * @expectedResult RC1101 before either binds
   */
  test("refuses a duplicate id", async () => {
    let bound = false;
    const plugin = definePlugin({
      id: "test.same",
      bind() {
        bound = true;
      },
    });
    const error = await refusal([plugin, { ...plugin }]);
    expect(error).toMatchObject({ rc: "RC1101" });
    expect(bound).toBe(false);
  });

  /**
   * @case Two plugins share a namespace
   * @preconditions "a.audit" and "b.audit", whose namespaces default to "audit"
   * @expectedResult RC1102 naming both
   */
  test("refuses a duplicate namespace", async () => {
    const error = await refusal([
      definePlugin({ id: "a.audit" }),
      definePlugin({ id: "b.audit" }),
    ]);
    expect(error).toMatchObject({ rc: "RC1102" });
    expect(String(error)).toContain("a.audit");
    expect(String(error)).toContain("b.audit");
  });

  /**
   * @case Two port tokens share a name
   * @preconditions A second port("test.store@1") call, as a duplicated contract module would make
   * @expectedResult RC1103
   */
  test("refuses two tokens with one port name", async () => {
    const copy = port<Store>("test.store@1");
    const error = await refusal([
      definePlugin({
        id: "test.provider",
        provides: [STORE],
        bind: (c) => c.provide(STORE, { kind: "a" }),
      }),
      definePlugin({ id: "test.consumer", requires: [copy] }),
    ]);
    expect(error).toMatchObject({ rc: "RC1103" });
  });

  /**
   * @case A port name that is not owner.capability@version
   * @preconditions port("Store")
   * @expectedResult RC1103 at the declaration
   */
  test("refuses a malformed port name", () => {
    expect(() => port("Store")).toThrow(
      expect.objectContaining({ rc: "RC1103" }),
    );
  });

  /**
   * @case A required port nobody provides
   * @preconditions One plugin requiring STORE, no provider
   * @expectedResult RC1104 naming the plugin and the port
   */
  test("refuses a missing provider", async () => {
    const error = await refusal([
      definePlugin({ id: "test.consumer", requires: [STORE] }),
    ]);
    expect(error).toMatchObject({ rc: "RC1104" });
    expect(String(error)).toContain("test.consumer");
    expect(String(error)).toContain("test.store@1");
  });

  /**
   * @case Two providers of one port and neither replaces
   * @preconditions Two plugins providing STORE
   * @expectedResult RC1105 naming both
   */
  test("refuses two providers", async () => {
    const provider = (id: string) =>
      definePlugin({
        id,
        provides: [STORE],
        bind: (c) => c.provide(STORE, { kind: id }),
      });
    const error = await refusal([provider("test.one"), provider("test.two")]);
    expect(error).toMatchObject({ rc: "RC1105" });
    expect(String(error)).toContain("test.one");
    expect(String(error)).toContain("test.two");
  });

  /**
   * @case A replacement is selected and the displaced provider still binds
   * @preconditions A default provider of STORE and a second that declares replaces: [STORE], listed after it
   * @expectedResult Both bind, and the context resolves STORE to the replacement
   */
  test("selects a replacement and still binds the displaced provider", async () => {
    const bound: string[] = [];
    const ours = definePlugin({
      id: "test.ours",
      provides: [STORE],
      bind(c) {
        bound.push("ours");
        c.provide(STORE, { kind: "ours" });
      },
    });
    const yours = definePlugin({
      id: "test.yours",
      provides: [STORE],
      replaces: [STORE],
      bind(c) {
        bound.push("yours");
        c.provide(STORE, { kind: "yours" });
      },
    });
    t = await testContext()
      .with({ plugins: [ours, yours] })
      .build();
    expect(bound).toEqual(["ours", "yours"]);
    expect(t.ctx.require(STORE)).toEqual({ kind: "yours" });
  });

  /**
   * @case A replacement that does not provide what it replaces, and two replacements
   * @preconditions replaces without provides; then two plugins both replacing STORE
   * @expectedResult RC1106 for each
   */
  test("refuses an invalid replacement", async () => {
    expect(
      await refusal([definePlugin({ id: "test.bad", replaces: [STORE] })]),
    ).toMatchObject({ rc: "RC1106" });
    const replacer = (id: string) =>
      definePlugin({
        id,
        provides: [STORE],
        replaces: [STORE],
        bind: (c) => c.provide(STORE, { kind: id }),
      });
    expect(
      await refusal([replacer("test.one"), replacer("test.two")]),
    ).toMatchObject({ rc: "RC1106" });
  });

  /**
   * @case Two plugins require what the other provides
   * @preconditions A provides A-port and requires B-port; B the reverse
   * @expectedResult RC1107 listing the edges
   */
  test("refuses a cycle", async () => {
    const A = port<number>("test.a@1");
    const B = port<number>("test.b@1");
    const error = await refusal([
      definePlugin({ id: "test.left", provides: [A], requires: [B] }),
      definePlugin({ id: "test.right", provides: [B], requires: [A] }),
    ]);
    expect(error).toMatchObject({ rc: "RC1107" });
    expect(String(error)).toContain("test.left -> test.right");
  });

  /**
   * @case require of a port the plugin did not declare
   * @preconditions A provider of STORE, and a plugin calling c.require(STORE) without listing it
   * @expectedResult RC1108
   */
  test("refuses an undeclared require", async () => {
    const error = await refusal([
      definePlugin({
        id: "test.provider",
        provides: [STORE],
        bind: (c) => c.provide(STORE, { kind: "a" }),
      }),
      definePlugin({
        id: "test.sneaky",
        bind(c) {
          c.require(STORE);
        },
      }),
    ]);
    expect(error).toMatchObject({ rc: "RC1108" });
  });

  /**
   * @case A provision that does not match the declaration
   * @preconditions A plugin providing STORE without declaring it; then one declaring STORE and never providing it
   * @expectedResult RC1109 for each
   */
  test("refuses a provision that does not match the declaration", async () => {
    expect(
      await refusal([
        definePlugin({
          id: "test.undeclared",
          bind: (c) => c.provide(STORE, { kind: "a" }),
        }),
      ]),
    ).toMatchObject({ rc: "RC1109" });
    expect(
      await refusal([definePlugin({ id: "test.forgot", provides: [STORE] })]),
    ).toMatchObject({ rc: "RC1109" });
  });

  /**
   * @case A contribution after the application froze
   * @preconditions A plugin that registers a route from start()
   * @expectedResult The start fails with RC1110 rather than adding a route that would miss compilation
   */
  test("refuses a contribution after freeze", async () => {
    const late = definePlugin({
      id: "test.late",
      start(c) {
        c.routes.register(
          ...craft().id("late").from(direct()).to(noop()).build(),
        );
      },
    });
    t = await testContext()
      .with({ plugins: [late] })
      .routes(craft().id("on-time").from(direct()).to(noop()))
      .build();
    await expect(t.ctx.start()).rejects.toMatchObject({ rc: "RC1110" });
  });

  /**
   * @case An optional port nobody provides
   * @preconditions A plugin declaring STORE optional, with no provider installed
   * @expectedResult lookup answers undefined and require throws RC1104
   */
  test("answers an absent optional port", async () => {
    let looked: Store | undefined = { kind: "unset" };
    let thrown: unknown;
    t = await testContext()
      .with({
        plugins: [
          definePlugin({
            id: "test.optional",
            optional: [STORE],
            bind(c) {
              looked = c.lookup(STORE);
              try {
                c.require(STORE);
              } catch (error) {
                thrown = error;
              }
            },
          }),
        ],
      })
      .build();
    expect(looked).toBeUndefined();
    expect(thrown).toMatchObject({ rc: "RC1104" });
    expect(t.ctx.lookup(STORE)).toBeUndefined();
  });

  /**
   * @case A plugin contributes a route in bind
   * @preconditions A plugin calling c.routes.register in bind
   * @expectedResult The route is registered and listed in the plugin's route view
   */
  test("registers routes a plugin contributes", async () => {
    let listed: string[] = [];
    t = await testContext()
      .with({
        plugins: [
          definePlugin({
            id: "test.contributor",
            bind(c) {
              c.routes.register(
                ...craft().id("contributed").from(direct()).to(noop()).build(),
              );
            },
            start(c) {
              listed = c.routes.list().map((route) => route.id);
            },
          }),
        ],
      })
      .build();
    await t.startAndWaitReady();
    expect(t.ctx.getRouteById("contributed")).toBeDefined();
    expect(listed).toContain("contributed");
  });

  /**
   * @case Disposers run in reverse order after the plugin's own stop
   * @preconditions A plugin registering two disposers in bind and a stop hook
   * @expectedResult stop, then the second disposer, then the first
   */
  test("runs disposers in reverse after stop", async () => {
    const order: string[] = [];
    t = await testContext()
      .with({
        plugins: [
          definePlugin({
            id: "test.disposing",
            bind(c) {
              c.onDispose(() => void order.push("first"));
              c.onDispose(() => void order.push("second"));
            },
            stop() {
              order.push("stop");
            },
          }),
        ],
      })
      .build();
    await t.ctx.stop();
    t = undefined;
    expect(order).toEqual(["stop", "second", "first"]);
  });

  /**
   * @case The pre-0.8 plugin shape
   * @preconditions An object with apply(ctx) and no id
   * @expectedResult RC9901 whose message names the migration
   */
  test("refuses the pre-0.8 shape with a migration hint", async () => {
    const error = await refusal([{ apply() {} } as unknown as Plugin]);
    expect(error).toMatchObject({ rc: "RC9901" });
    expect(String(error)).toContain("bind(c)");
  });
});
