import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  ContextBuilder,
  OperationType,
  craft,
  definePlugin,
  direct,
  isHookRefusal,
  defaultAuthority,
  noop,
  refuse,
  type Adapter,
  type ErrorHook,
  type Exchange,
  type ExchangeHook,
  type HookInfo,
  type Hooks,
  type HooksConfig,
  type MutateHook,
  type ObserveHook,
  type Plugin,
  type Principal,
  type Source,
  type Step,
  type WrapperHook,
} from "../src/index.ts";
import { PUSH_STEP } from "../src/dsl-symbol.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A plugin with the given hooks and nothing else. */
/** Hooks as a test writes them: an id defaults to the slot and position. */
type Loosen<H> = H extends object
  ? Omit<H, "id"> & { readonly id?: string }
  : never;
type ElementOf<T> = T extends readonly (infer E)[] ? E : T;
type LooseSlot<T> = Loosen<ElementOf<Exclude<T, undefined>>>;
type LooseHooks = {
  readonly [K in Exclude<keyof Hooks, "points">]?:
    LooseSlot<Hooks[K]> | readonly LooseSlot<Hooks[K]>[];
} & {
  readonly points?: Readonly<
    Record<string, Loosen<ExchangeHook> | readonly Loosen<ExchangeHook>[]>
  >;
};
type LooseHook = Loosen<ExchangeHook | WrapperHook | ErrorHook>;

function named(slot: string, hooks: LooseHook | readonly LooseHook[]): unknown {
  const list = Array.isArray(hooks) ? hooks : [hooks];
  const stamped = list.map((hook, index) => ({
    id: `${slot}${index}`,
    ...hook,
  }));
  return Array.isArray(hooks) ? stamped : stamped[0];
}

function plugin(id: string, hooks: LooseHooks): Plugin {
  const { points, ...slots } = hooks;
  const built: Record<string, unknown> = {};
  for (const [slot, declared] of Object.entries(slots)) {
    if (declared !== undefined) built[slot] = named(slot, declared);
  }
  if (points !== undefined) {
    built["points"] = Object.fromEntries(
      Object.entries(points).map(([point, declared]) => [
        point,
        named(point, declared),
      ]),
    );
  }
  return definePlugin({ id, hooks: built as Hooks });
}

/** An observe hook that records `label` each time it runs. */
function recorder(
  label: string,
  log: string[],
  extra: Partial<Pick<ObserveHook, "id" | "routes" | "tags">> = {},
): ObserveHook {
  return {
    id: extra.id ?? label,
    phase: "observe",
    ...(extra.routes ? { routes: extra.routes } : {}),
    ...(extra.tags ? { tags: extra.tags } : {}),
    run(_exchange: Exchange, info: HookInfo) {
      log.push(extra.routes || extra.tags ? `${info.routeId}:${label}` : label);
    },
  };
}

/** A mutate hook that sets one header to `value`. */
function setHeader(id: string, header: string, value: string): MutateHook {
  return { id, phase: "mutate", run: () => ({ headers: { [header]: value } }) };
}

/**
 * A source that emits one body carrying an authentic principal, the way an
 * authenticating transport hands one to the route.
 */
function principalSource<T>(body: T, principal?: Principal): Source<T> {
  return {
    subscribe: async (sub) => {
      const headers = principal
        ? { "routecraft.auth.principal": defaultAuthority.brand(principal) }
        : undefined;
      await sub.emit({ message: body, ...(headers ? { headers } : {}) });
    },
  };
}

/** A schema that coerces `{ n: string }` into `{ n: number }`. */
const numeric: StandardSchemaV1<unknown, { n: number }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({
      value: { n: Number((value as { n: string }).n) },
    }),
  },
};

/** A schema that accepts anything and records what it was asked to validate. */
function recordingSchema(log: unknown[]): StandardSchemaV1 {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) => {
        log.push(value);
        return { value };
      },
    },
  };
}

/** A custom step that runs the hooks placed at a declared point. */
function invokeStep(point: string): Step<Adapter> {
  return {
    operation: OperationType.PROCESS,
    adapter: { adapterId: "test.invoke" },
    async execute(exchange, ctx) {
      return { kind: "continue", exchange: await ctx.invoke(point, exchange) };
    },
  };
}

/** Build a context from plugins and hooks config and return what its build refused with. */
async function refusal(
  plugins: Plugin[],
  hooks?: HooksConfig,
): Promise<unknown> {
  try {
    await new ContextBuilder()
      .with({ plugins, ...(hooks ? { hooks } : {}) })
      .build();
  } catch (error) {
    return error;
  }
  throw new Error("the build did not refuse");
}

/** The messages of every warn call on a spy logger whose message contains `text`. */
function warnings(t: TestContext, text: string): string[] {
  return t.contextLogger.warn.mock.calls
    .map((call) => call[1])
    .filter(
      (message): message is string =>
        typeof message === "string" && message.includes(text),
    );
}

/**
 * The chain's slots other than `error`: hooks placed by plugins around the
 * framework's positions, run phase by phase in plugin list order unless the
 * application says otherwise, plus points a plugin declares for other
 * plugins to hook.
 */
describe("chain hooks", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case beforeAuth, afterAuth and admitted sit around the authorize position and before the pipeline
   * @preconditions A route with .authorize() and an .input() schema that coerces the body; one exchange with a principal, one without
   * @expectedResult With a principal: beforeAuth, afterAuth, admitted, then the pipeline, and admitted sees the parsed body while afterAuth sees the raw one. Without: beforeAuth runs, authorize refuses with RC5012, and nothing after it runs
   */
  test("beforeAuth, afterAuth and admitted run in order around authorize", async () => {
    const seen: string[] = [];
    const bodies: Record<string, unknown> = {};
    const failures: unknown[] = [];
    const principal: Principal = {
      kind: "custom",
      scheme: "bearer",
      subject: "user-1",
    };
    const slot = (name: string): ObserveHook => ({
      id: name,
      phase: "observe",
      run(exchange, info) {
        seen.push(`${info.routeId}:${name}`);
        if (info.routeId === "signed") bodies[name] = exchange.body;
      },
    });
    t = await testContext()
      .with({
        plugins: [
          plugin("test.trace", {
            beforeAuth: slot("beforeAuth"),
            afterAuth: slot("afterAuth"),
            admitted: slot("admitted"),
          }),
        ],
      })
      .routes([
        craft()
          .id("signed")
          .authorize()
          .input(numeric)
          .from(principalSource({ n: "3" }, principal))
          .process((ex) => {
            seen.push("signed:pipeline");
            return ex;
          })
          .to(noop()),
        craft()
          .id("anonymous")
          .authorize()
          .input(numeric)
          .from(principalSource({ n: "3" }))
          .process((ex) => {
            seen.push("anonymous:pipeline");
            return ex;
          })
          .to(noop()),
      ])
      .build();
    t.ctx.on("route:exchange:failed", ({ details }) => {
      failures.push(details.error);
    });

    await t.test();

    expect(seen.filter((s) => s.startsWith("signed:"))).toEqual([
      "signed:beforeAuth",
      "signed:afterAuth",
      "signed:admitted",
      "signed:pipeline",
    ]);
    expect(seen.filter((s) => s.startsWith("anonymous:"))).toEqual([
      "anonymous:beforeAuth",
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ rc: "RC5012" });
    expect(bodies["afterAuth"]).toEqual({ n: "3" });
    expect(bodies["admitted"]).toEqual({ n: 3 });
  });

  /**
   * @case A slot runs observe, then mutate, then validate, whatever order the plugins are listed in
   * @preconditions Four plugins in one slot listed validate, observe (second), mutate, observe (first)
   * @expectedResult Both observe hooks run first in plugin list order, then mutate, then validate
   */
  test("phases run observe, mutate, validate; plugin list order inside a phase", async () => {
    const seen: string[] = [];
    t = await testContext()
      .with({
        plugins: [
          plugin("test.validator", {
            beforeAuth: {
              phase: "validate",
              run() {
                seen.push("validate");
              },
            },
          }),
          plugin("test.observerB", { beforeAuth: recorder("observe:b", seen) }),
          plugin("test.mutator", {
            beforeAuth: {
              phase: "mutate",
              run() {
                seen.push("mutate");
              },
            },
          }),
          plugin("test.observerA", { beforeAuth: recorder("observe:a", seen) }),
        ],
      })
      .routes([craft().id("work").from(direct()).to(noop())])
      .build();
    await t.startAndWaitReady();

    await t.client.sendDirect("work", {});

    expect(seen).toEqual(["observe:b", "observe:a", "mutate", "validate"]);
  });

  /**
   * @case A mutate hook's patch reaches the pipeline
   * @preconditions A mutate hook in admitted returning a header and a replacement body
   * @expectedResult The pipeline sees both, and the caller receives the patched body
   */
  test("a mutate hook's headers and body reach the pipeline", async () => {
    let header: unknown;
    t = await testContext()
      .with({
        plugins: [
          plugin("test.tenancy", {
            admitted: {
              phase: "mutate",
              run: (exchange) => ({
                headers: { "x-tenant": "acme" },
                body: { ...(exchange.body as object), tenant: "acme" },
              }),
            },
          }),
        ],
      })
      .routes([
        craft()
          .id("work")
          .from(direct())
          .process((ex) => {
            header = ex.headers["x-tenant"];
            return ex;
          })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    const body = await t.client.sendDirect("work", { order: 1 });

    expect(header).toBe("acme");
    expect(body).toEqual({ order: 1, tenant: "acme" });
  });

  /**
   * @case A mutate hook that writes an engine-owned header
   * @preconditions A beforeAuth mutate hook returning a patch that sets routecraft.route
   * @expectedResult The exchange fails with RC1115 naming the header, the same contract .header() enforces at construction. A hook rewriting which route owns an exchange would make every later event lie about it
   */
  test("a mutate hook may not write an engine-owned header", async () => {
    t = await testContext()
      .with({
        plugins: [
          plugin("test.owner", {
            beforeAuth: setHeader("owner", "routecraft.route", "elsewhere"),
          }),
        ],
      })
      .routes([craft().id("work").from(direct()).to(noop())])
      .build();
    await t.startAndWaitReady();

    await expect(t.client.sendDirect("work", {})).rejects.toMatchObject({
      rc: "RC1115",
      message: expect.stringContaining("routecraft.route"),
    });
  });

  /**
   * @case Two mutate hooks writing one header: the later wins and the framework warns once per route
   * @preconditions Two plugins whose admitted mutate hooks both write x-tenant, no writes declared; two routes, two exchanges each
   * @expectedResult The later hook's value reaches the pipeline, and exactly one warning per route names both hooks
   */
  test("a header written twice in one slot warns once per route, naming both", async () => {
    const tenants: unknown[] = [];
    t = await testContext()
      .with({
        plugins: [
          plugin("test.legacy", {
            admitted: setHeader("tenant", "x-tenant", "legacy"),
          }),
          plugin("test.tenancy", {
            admitted: setHeader("tenant", "x-tenant", "tenancy"),
          }),
        ],
      })
      .routes(
        ["one", "two"].map((id) =>
          craft()
            .id(id)
            .from(direct())
            .process((ex) => {
              tenants.push(ex.headers["x-tenant"]);
              return ex;
            })
            .to(noop()),
        ),
      )
      .build();
    await t.startAndWaitReady();
    expect(warnings(t, "x-tenant")).toEqual([]);

    await t.client.sendDirect("one", {});
    await t.client.sendDirect("one", {});
    await t.client.sendDirect("two", {});
    await t.client.sendDirect("two", {});

    expect(tenants).toEqual(["tenancy", "tenancy", "tenancy", "tenancy"]);
    const warned = warnings(t, "x-tenant");
    expect(warned).toHaveLength(2);
    for (const message of warned) {
      expect(message).toContain("test.legacy/tenant");
      expect(message).toContain("test.tenancy/tenant");
    }
    expect(warned.some((m) => m.includes('"one"'))).toBe(true);
    expect(warned.some((m) => m.includes('"two"'))).toBe(true);
  });

  /**
   * @case A mutate hook that declares writes moves the conflict warning to start
   * @preconditions Two plugins whose beforeAuth mutate hooks both declare and write x-tenant
   * @expectedResult One warning naming both hooks is logged when the hooks are placed at build, before any traffic, and traffic does not warn again
   */
  test("declared writes make a header conflict warn at build", async () => {
    t = await testContext()
      .with({
        plugins: [
          plugin("test.legacy", {
            beforeAuth: {
              ...setHeader("tenant", "x-tenant", "legacy"),
              writes: ["x-tenant"],
            },
          }),
          plugin("test.tenancy", {
            beforeAuth: {
              ...setHeader("tenant", "x-tenant", "tenancy"),
              writes: ["x-tenant"],
            },
          }),
        ],
      })
      .routes([craft().id("work").from(direct()).to(noop())])
      .build();

    const atBuild = warnings(t, "x-tenant");
    expect(atBuild).toHaveLength(1);
    expect(atBuild[0]).toContain("test.legacy/tenant");
    expect(atBuild[0]).toContain("test.tenancy/tenant");

    await t.startAndWaitReady();
    await t.client.sendDirect("work", {});

    expect(warnings(t, "x-tenant")).toHaveLength(1);
  });

  /**
   * @case A validate hook refuses with refuse(reason)
   * @preconditions A beforeAuth validate hook refusing exchanges without x-tenant, and an error-slot observe hook
   * @expectedResult The refused exchange fails with RC5068 naming the hook and the reason, the error slot hears it, and an exchange carrying the header passes
   */
  test("a validate refusal fails the exchange with RC5068 and reaches the error slot", async () => {
    const heard: unknown[] = [];
    t = await testContext()
      .with({
        plugins: [
          plugin("test.guard", {
            beforeAuth: {
              id: "tenant",
              phase: "validate",
              run: (exchange) =>
                exchange.headers["x-tenant"] === undefined
                  ? refuse("no tenant header")
                  : undefined,
            },
          }),
          plugin("test.listener", {
            error: {
              phase: "observe",
              run(error) {
                heard.push((error as { rc?: string }).rc);
              },
            },
          }),
        ],
      })
      .routes([craft().id("work").from(direct()).to(noop())])
      .build();
    await t.startAndWaitReady();

    const refused = await t.client.sendDirect("work", {}).catch((e) => e);

    expect(refused).toMatchObject({ rc: "RC5068" });
    expect((refused as Error).message).toContain("test.guard/tenant");
    expect((refused as Error).message).toContain("no tenant header");
    const cause = (refused as Error).cause;
    expect(isHookRefusal(cause)).toBe(true);
    expect(isHookRefusal(cause) && cause.refused).toEqual({
      hook: "test.guard/tenant",
      slot: "beforeAuth",
      routeId: "work",
      kind: "forbidden",
      reason: "no tenant header",
    });
    expect(heard).toEqual(["RC5068"]);

    await expect(
      t.client.sendDirect("work", { ok: true }, { "x-tenant": "acme" }),
    ).resolves.toEqual({ ok: true });
  });

  /**
   * @case A validate hook names how a door should answer its refusal
   * @preconditions An admitted validate hook refusing with refuse(reason, { kind: "not_found" })
   * @expectedResult The RC5068 carries the kind on its detail and names it in the message
   */
  test("a refusal carries the kind the hook chose", async () => {
    t = await testContext()
      .with({
        plugins: [
          plugin("test.lookup", {
            admitted: {
              id: "exists",
              phase: "validate",
              run: () => refuse("no such record", { kind: "not_found" }),
            },
          }),
        ],
      })
      .routes([craft().id("work").from(direct()).to(noop())])
      .build();
    await t.startAndWaitReady();

    const refused = await t.client.sendDirect("work", {}).catch((e) => e);

    expect(refused).toMatchObject({ rc: "RC5068" });
    expect((refused as Error).message).toContain("(not_found)");
    const cause = (refused as Error).cause;
    expect(isHookRefusal(cause) && cause.refused.kind).toBe("not_found");
  });

  /**
   * @case An observe hook that returns a value breaks its phase
   * @preconditions A beforeAuth observe hook returning an object
   * @expectedResult The exchange fails with RC1115 naming the hook
   */
  test("an observe hook returning a value fails with RC1115", async () => {
    t = await testContext()
      .with({
        plugins: [
          plugin("test.chatty", {
            beforeAuth: {
              id: "talks",
              phase: "observe",
              run: () => ({ headers: { x: "1" } }) as never,
            },
          }),
        ],
      })
      .routes([craft().id("work").from(direct()).to(noop())])
      .build();
    await t.startAndWaitReady();

    const failed = await t.client.sendDirect("work", {}).catch((e) => e);

    expect(failed).toMatchObject({ rc: "RC1115" });
    expect((failed as Error).message).toContain("test.chatty/talks");
  });

  /**
   * @case A validate hook that returns anything but a refusal breaks its phase
   * @preconditions An admitted validate hook returning a patch
   * @expectedResult The exchange fails with RC1115 naming the hook
   */
  test("a validate hook returning a non-refusal fails with RC1115", async () => {
    t = await testContext()
      .with({
        plugins: [
          plugin("test.sneaky", {
            admitted: {
              id: "patches",
              phase: "validate",
              run: () => ({ body: "changed" }) as never,
            },
          }),
        ],
      })
      .routes([craft().id("work").from(direct()).to(noop())])
      .build();
    await t.startAndWaitReady();

    const failed = await t.client.sendDirect("work", {}).catch((e) => e);

    expect(failed).toMatchObject({ rc: "RC1115" });
    expect((failed as Error).message).toContain("test.sneaky/patches");
  });

  /**
   * @case Shape violations are refused when the hooks are placed
   * @preconditions One plugin declaring a validate hook in exit; another declaring a perAttempt entry with no wrap
   * @expectedResult Each build fails with RC1115
   */
  test("validate in exit and a perAttempt entry without wrap fail the build with RC1115", async () => {
    expect(
      await refusal([
        plugin("test.exitValidate", {
          exit: { phase: "validate", run: () => undefined } as never,
        }),
      ]),
    ).toMatchObject({ rc: "RC1115" });

    expect(
      await refusal([
        plugin("test.noWrap", {
          perAttempt: { run: () => undefined } as never,
        }),
      ]),
    ).toMatchObject({ rc: "RC1115" });
  });

  /**
   * @case A hook in a slot that does not exist is refused, at compile time and at build
   * @preconditions A plugin declaring a hook under "beforeAuthz", a misspelled slot, in a typed hooks object
   * @expectedResult The object literal is a type error, and a plugin that bypasses the types (plain JavaScript) still fails the build with RC1112 naming the key
   */
  test("a hook in an unknown slot fails the build with RC1112", async () => {
    const error = await refusal([
      plugin("test.typo", {
        // @ts-expect-error a misspelled slot is a compile error; this checks the runtime refusal JavaScript still gets
        beforeAuthz: { phase: "observe", run: () => undefined },
      }),
    ]);

    expect(error).toMatchObject({ rc: "RC1112" });
    expect((error as Error).message).toContain("beforeAuthz");
  });

  /**
   * @case hooks.order and hooks.disable must name hooks that exist
   * @preconditions One installed hook; config naming a hook id nobody declares, and an order key that is not slot/phase
   * @expectedResult Each build fails with RC1112
   */
  test("hooks.order or hooks.disable naming nothing fails the build with RC1112", async () => {
    const installed = [
      plugin("test.real", { beforeAuth: recorder("seen", []) }),
    ];

    expect(
      await refusal(installed, { disable: ["test.real/missing"] }),
    ).toMatchObject({ rc: "RC1112" });
    expect(
      await refusal(installed, {
        order: { "beforeAuth/observe": ["test.ghost/seen"] },
      }),
    ).toMatchObject({ rc: "RC1112" });
    expect(
      await refusal(installed, {
        order: { "beforeAuth/mutate": ["test.real/seen"] },
      }),
    ).toMatchObject({ rc: "RC1112" });
    expect(
      await refusal(installed, { order: { beforeAuth: ["test.real/seen"] } }),
    ).toMatchObject({ rc: "RC1112" });
  });

  /**
   * @case Two plugins cannot declare one point
   * @preconditions Two plugins both declaring the point "acme.decided"
   * @expectedResult RC1113 naming both plugins
   */
  test("a point declared twice fails the build with RC1113", async () => {
    const error = await refusal([
      definePlugin({ id: "test.one", points: [{ name: "acme.decided" }] }),
      definePlugin({ id: "test.two", points: [{ name: "acme.decided" }] }),
    ]);

    expect(error).toMatchObject({ rc: "RC1113" });
    expect((error as Error).message).toContain("test.one");
    expect((error as Error).message).toContain("test.two");
  });

  /**
   * @case hooks.order overrides plugin list order inside one phase
   * @preconditions Two observe hooks in beforeAuth from plugins listed a then b, with hooks.order naming b first
   * @expectedResult b runs before a
   */
  test("hooks.order overrides plugin list order", async () => {
    const seen: string[] = [];
    t = await testContext()
      .with({
        plugins: [
          plugin("test.a", { beforeAuth: recorder("a", seen, { id: "see" }) }),
          plugin("test.b", { beforeAuth: recorder("b", seen, { id: "see" }) }),
        ],
        hooks: { order: { "beforeAuth/observe": ["test.b/see"] } },
      })
      .routes([craft().id("work").from(direct()).to(noop())])
      .build();
    await t.startAndWaitReady();

    await t.client.sendDirect("work", {});

    expect(seen).toEqual(["b", "a"]);
  });

  /**
   * @case hooks.order naming one hook twice
   * @preconditions Two observe hooks in beforeAuth; an order list naming one of them twice, and a valid order naming each once
   * @expectedResult The repeated id fails the build with RC1112 naming the key and the id; under the valid order each hook runs exactly once per exchange
   */
  test("hooks.order naming a hook twice fails the build with RC1112", async () => {
    const seen: string[] = [];
    const plugins = () => [
      plugin("test.a", { beforeAuth: recorder("a", seen, { id: "see" }) }),
      plugin("test.b", { beforeAuth: recorder("b", seen, { id: "see" }) }),
    ];

    const error = await refusal(plugins(), {
      order: {
        "beforeAuth/observe": ["test.b/see", "test.a/see", "test.b/see"],
      },
    });
    expect(error).toMatchObject({ rc: "RC1112" });
    expect((error as Error).message).toContain(
      'hooks.order["beforeAuth/observe"]',
    );
    expect((error as Error).message).toContain('"test.b/see" twice');

    t = await testContext()
      .with({
        plugins: plugins(),
        hooks: {
          order: { "beforeAuth/observe": ["test.b/see", "test.a/see"] },
        },
      })
      .routes([craft().id("work").from(direct()).to(noop())])
      .build();
    await t.startAndWaitReady();
    await t.client.sendDirect("work", {});

    expect(seen).toEqual(["b", "a"]);
  });

  /**
   * @case An admission-slot hook whose runs leaves normal out
   * @preconditions A hook in beforeAuth, in afterAuth and in admitted, each declaring runs: ["resume"]; a control in admitted declaring runs: ["normal", "resume"]
   * @expectedResult Each of the three fails the build with RC1115 naming its slot, since those slots see every admission, a resumed one included, as normal and the hook could never run; the control installs and runs on a normal exchange
   */
  test("an admission hook that leaves normal out of runs fails the build with RC1115", async () => {
    for (const slot of ["beforeAuth", "afterAuth", "admitted"] as const) {
      const error = await refusal([
        plugin("test.never", {
          [slot]: { phase: "observe", runs: ["resume"], run: () => undefined },
        } as LooseHooks),
      ]);
      expect(error).toMatchObject({ rc: "RC1115" });
      expect((error as Error).message).toContain(`hook in "${slot}"`);
      expect((error as Error).message).toContain('include "normal"');
    }

    const seen: string[] = [];
    t = await testContext()
      .with({
        plugins: [
          plugin("test.both", {
            admitted: {
              ...recorder("admitted", seen),
              runs: ["normal", "resume"],
            },
          }),
        ],
      })
      .routes([craft().id("work").from(direct()).to(noop())])
      .build();
    await t.startAndWaitReady();
    await t.client.sendDirect("work", {});

    expect(seen).toEqual(["admitted"]);
  });

  /**
   * @case hooks.disable removes one hook and leaves the rest of its slot
   * @preconditions Two observe hooks in beforeAuth, one disabled by id
   * @expectedResult Only the other runs
   */
  test("hooks.disable removes a hook", async () => {
    const seen: string[] = [];
    t = await testContext()
      .with({
        plugins: [
          plugin("test.a", { beforeAuth: recorder("a", seen, { id: "see" }) }),
          plugin("test.b", { beforeAuth: recorder("b", seen, { id: "see" }) }),
        ],
        hooks: { disable: ["test.a/see"] },
      })
      .routes([craft().id("work").from(direct()).to(noop())])
      .build();
    await t.startAndWaitReady();

    await t.client.sendDirect("work", {});

    expect(seen).toEqual(["b"]);
  });

  /**
   * @case Selectors place a hook on the routes it names, by id or by tag
   * @preconditions One hook selecting route "one" by id, another selecting tag "billing"; three routes, one of them tagged
   * @expectedResult Each hook runs only on its routes, and the unselected route runs neither
   */
  test("routes and tags select where a hook applies", async () => {
    const seen: string[] = [];
    t = await testContext()
      .with({
        plugins: [
          plugin("test.byId", {
            admitted: recorder("byId", seen, { routes: ["one"] }),
          }),
          plugin("test.byTag", {
            admitted: recorder("byTag", seen, { tags: ["billing"] }),
          }),
        ],
      })
      .routes([
        craft().id("one").from(direct()).to(noop()),
        craft().id("two").tag("billing").from(direct()).to(noop()),
        craft().id("three").from(direct()).to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    await t.client.sendDirect("one", {});
    await t.client.sendDirect("two", {});
    await t.client.sendDirect("three", {});

    expect(seen).toEqual(["one:byId", "two:byTag"]);
  });

  /**
   * @case A perAttempt wrapper surrounds every attempt of a route-scope retry
   * @preconditions A route with .retry({ maxAttempts: 3 }) whose step fails twice then succeeds, and one perAttempt wrapper
   * @expectedResult The wrapper is called three times, once per attempt, and the third attempt's body reaches the caller
   */
  test("a perAttempt wrapper runs once per retry attempt", async () => {
    let wraps = 0;
    let attempts = 0;
    t = await testContext()
      .with({
        plugins: [
          plugin("test.attempts", {
            perAttempt: {
              id: "count",
              async wrap(proceed) {
                wraps += 1;
                await proceed();
              },
            },
          }),
        ],
      })
      .routes([
        craft()
          .id("flaky")
          .retry({ maxAttempts: 3, backoff: 1 })
          .from(direct())
          .transform(() => {
            attempts += 1;
            if (attempts < 3) throw new Error("not yet");
            return { attempt: attempts };
          })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    const body = await t.client.sendDirect("flaky", {});

    expect(body).toEqual({ attempt: 3 });
    expect(attempts).toBe(3);
    expect(wraps).toBe(3);
  });

  /**
   * @case A perAttempt wrapper sits outside the route-scope timeout
   * @preconditions A route with .timeout(50ms) whose step is instant, and a wrapper that spends 150ms before calling proceed
   * @expectedResult The exchange completes: the deadline starts inside the wrapper, so the wrapper's own time does not count against it
   */
  test("a perAttempt wrapper sits outside the route-scope timeout", async () => {
    t = await testContext()
      .with({
        plugins: [
          plugin("test.slowWrapper", {
            perAttempt: {
              id: "slow",
              async wrap(proceed) {
                await sleep(150);
                await proceed();
              },
            },
          }),
        ],
      })
      .routes([
        craft()
          .id("bounded")
          .timeout(50)
          .from(direct())
          .transform(() => ({ done: true }))
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    await expect(t.client.sendDirect("bounded", {})).resolves.toEqual({
      done: true,
    });
  });

  /**
   * @case A wrapper that never calls proceed breaks its contract
   * @preconditions A perAttempt wrapper that returns without calling proceed
   * @expectedResult The exchange fails with RC1115 and the route's step never runs
   */
  test("a perAttempt wrapper that never calls proceed fails with RC1115", async () => {
    let ran = false;
    t = await testContext()
      .with({
        plugins: [
          plugin("test.swallow", {
            perAttempt: { id: "swallow", async wrap() {} },
          }),
        ],
      })
      .routes([
        craft()
          .id("work")
          .from(direct())
          .transform((body) => {
            ran = true;
            return body;
          })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    await expect(t.client.sendDirect("work", {})).rejects.toMatchObject({
      rc: "RC1115",
    });
    expect(ran).toBe(false);
  });

  /**
   * @case A wrapper that starts the attempt without awaiting it
   * @preconditions A perAttempt wrapper that calls proceed() and returns at once; the route's step takes a moment
   * @expectedResult The exchange completes with the step's output once, rather than failing while the attempt still runs. Failing early would let a retry start a second attempt beside the first, both with side effects
   */
  test("a perAttempt wrapper that does not await proceed still yields the attempt", async () => {
    let runs = 0;
    t = await testContext()
      .with({
        plugins: [
          plugin("test.fireAndForget", {
            perAttempt: {
              id: "fireAndForget",
              wrap(proceed) {
                void proceed();
                return Promise.resolve();
              },
            },
          }),
        ],
      })
      .routes([
        craft()
          .id("work")
          .from(direct())
          .transform(async () => {
            runs++;
            await sleep(10);
            return "done";
          }),
      ])
      .build();
    await t.startAndWaitReady();

    expect((await t.client.sendDirect("work", {})) as string).toBe("done");
    expect(runs).toBe(1);
  });

  /**
   * @case A wrapper that calls proceed twice
   * @preconditions A perAttempt wrapper that awaits proceed() two times
   * @expectedResult The second call fails with RC1115 and the step ran once. Running the attempt twice from inside one attempt is a retry nobody configured
   */
  test("a perAttempt wrapper that calls proceed twice fails with RC1115", async () => {
    let runs = 0;
    t = await testContext()
      .with({
        plugins: [
          plugin("test.twice", {
            perAttempt: {
              id: "twice",
              async wrap(proceed) {
                await proceed();
                await proceed();
              },
            },
          }),
        ],
      })
      .routes([
        craft()
          .id("work")
          .from(direct())
          .transform((body) => {
            runs++;
            return body;
          }),
      ])
      .build();
    await t.startAndWaitReady();

    await expect(t.client.sendDirect("work", {})).rejects.toMatchObject({
      rc: "RC1115",
    });
    expect(runs).toBe(1);
  });

  /**
   * @case exit hooks run over completed exchanges only and may change what the caller receives
   * @preconditions An exit mutate hook stamping the body; one route that completes, one whose filter drops, one whose step fails
   * @expectedResult Only the completed route reaches the hook, and its caller receives the stamped body
   */
  test("exit hooks run on completed exchanges only and may change the body", async () => {
    const reached: string[] = [];
    t = await testContext()
      .with({
        plugins: [
          plugin("test.stamp", {
            exit: {
              phase: "mutate",
              run(exchange, info) {
                reached.push(info.routeId);
                return { body: { ...(exchange.body as object), stamped: 1 } };
              },
            },
          }),
        ],
      })
      .routes([
        craft().id("completes").from(direct()).to(noop()),
        craft()
          .id("drops")
          .from(direct())
          .filter(() => false)
          .to(noop()),
        craft()
          .id("fails")
          .from(direct())
          .transform(() => {
            throw new Error("boom");
          })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    await expect(t.client.sendDirect("completes", { a: 1 })).resolves.toEqual({
      a: 1,
      stamped: 1,
    });
    await expect(t.client.sendDirect("drops", {})).rejects.toMatchObject({
      rc: "RC5031",
    });
    await expect(t.client.sendDirect("fails", {})).rejects.toThrow("boom");

    expect(reached).toEqual(["completes"]);
  });

  /**
   * @case exit runs before the route's .output() validation
   * @preconditions An exit mutate hook replacing the body, and a route .output() schema that records what it validates
   * @expectedResult The output schema validates the body the exit hook produced
   */
  test("exit hooks run before .output() validation", async () => {
    const validated: unknown[] = [];
    t = await testContext()
      .with({
        plugins: [
          plugin("test.stamp", {
            exit: { phase: "mutate", run: () => ({ body: { from: "exit" } }) },
          }),
        ],
      })
      .routes([
        craft()
          .id("work")
          .output(recordingSchema(validated))
          .from(direct())
          .transform(() => ({ from: "pipeline" }))
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    const body = await t.client.sendDirect("work", {});

    expect(validated).toEqual([{ from: "exit" }]);
    expect(body).toEqual({ from: "exit" });
  });

  /**
   * @case A throwing exit hook fails the exchange
   * @preconditions An exit observe hook that throws on a route that otherwise completes
   * @expectedResult The caller receives the hook's error and route:exchange:failed fires
   */
  test("a throwing exit hook fails the exchange", async () => {
    const failed: unknown[] = [];
    t = await testContext()
      .with({
        plugins: [
          plugin("test.audit", {
            exit: {
              phase: "observe",
              run() {
                throw new Error("audit sink is down");
              },
            },
          }),
        ],
      })
      .routes([craft().id("work").from(direct()).to(noop())])
      .build();
    t.ctx.on("route:exchange:failed", ({ details }) => {
      failed.push(details.error);
    });
    await t.startAndWaitReady();

    await expect(t.client.sendDirect("work", {})).rejects.toThrow(
      "audit sink is down",
    );
    expect(failed).toHaveLength(1);
  });

  /**
   * @case A plugin declares a point, its step invokes it, and another plugin's hook there mutates
   * @preconditions Plugin A declares "acme.decided"; plugin B places a mutate hook at it; a route runs a custom step calling ctx.invoke("acme.decided", exchange)
   * @expectedResult The hook sees the point as its slot, and its patch is what continues down the route
   */
  test("a declared point runs the hooks other plugins place there", async () => {
    let slot: string | undefined;
    const decided: MutateHook = {
      id: "stamp",
      phase: "mutate",
      run(exchange, info) {
        slot = info.slot;
        return {
          headers: { "x-decided": "yes" },
          body: { ...(exchange.body as object), decided: true },
        };
      },
    };
    let header: unknown;
    t = await testContext()
      .with({
        plugins: [
          definePlugin({ id: "test.acme", points: [{ name: "acme.decided" }] }),
          plugin("test.listener", { points: { "acme.decided": decided } }),
        ],
      })
      .routes([
        craft()
          .id("work")
          .from(direct())
          [PUSH_STEP](invokeStep("acme.decided"))
          .process((ex) => {
            header = ex.headers["x-decided"];
            return ex;
          })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    const body = await t.client.sendDirect("work", { id: 1 });

    expect(slot).toBe("acme.decided");
    expect(header).toBe("yes");
    expect(body).toEqual({ id: 1, decided: true });
  });

  /**
   * @case Invoking a point nobody declared fails the exchange
   * @preconditions A route whose custom step invokes "acme.undeclared", with no plugin declaring it
   * @expectedResult The exchange fails with RC1112 naming the point
   */
  test("invoking an undeclared point fails with RC1112", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("work")
          .from(direct())
          [PUSH_STEP](invokeStep("acme.undeclared"))
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    const failed = await t.client.sendDirect("work", {}).catch((e) => e);

    expect(failed).toMatchObject({ rc: "RC1112" });
    expect((failed as Error).message).toContain("acme.undeclared");
  });
});
