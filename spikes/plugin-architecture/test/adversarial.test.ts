/** Passing characterisation tests: these deliberately assert defects, not desired behavior. */
import { expect, test } from "bun:test";
import { Kernel } from "../src/kernel/index.ts";
import {
  token,
  type Plugin,
  type PluginContext,
  type WrapperContribution,
} from "../src/contracts/index.ts";
import { Runtime, type RouteSpec } from "../src/runtime/index.ts";
import { stores, STORE_API } from "../src/plugins/stores.ts";
import { deferral, DEFERRAL_API } from "../src/plugins/deferral.ts";
import { resilience } from "../src/plugins/resilience.ts";
import { derivedBuilder, type TypedPlugin } from "../src/builder/index.ts";
import { chain } from "../src/typed/c-merged.ts";
const spec = (steps: RouteSpec["steps"] = []): RouteSpec => ({
  id: "r",
  source: { label: "s", subscribe: async () => () => {} },
  steps,
});

/**
 * @case replacement with its own identity cannot satisfy provider dependency
 * @preconditions A store provider publishes the right token under its own ID.
 * @expectedResult Kernel construction rejects the missing first-party ID.
 */
test("replacement with its own identity cannot satisfy provider dependency", () => {
  const replacement = { ...stores(), id: "acme.stores" };
  expect(() => new Kernel([replacement, deferral()])).toThrow(
    "routecraft.stores",
  );
});
/**
 * @case two independently typed tokens with the same name corrupt type safety
 * @preconditions Number and string tokens independently use the same Symbol.for name.
 * @expectedResult A string-typed lookup returns a number and its string method throws.
 */
test("two independently typed tokens with the same name corrupt type safety", () => {
  const k = new Kernel([]);
  k.services.provide(token<number>("collision"), 7, "number-provider");
  const supposedString: string = k.services.require(
    token<string>("collision"),
    "consumer",
  );
  expect(() => supposedString.toUpperCase()).toThrow(TypeError);
});
/**
 * @case provider replacement is still silent last-writer-wins
 * @preconditions Two providers publish the same token in sequence.
 * @expectedResult The second value replaces the first without a diagnostic.
 */
test("provider replacement is still silent last-writer-wins", () => {
  const k = new Kernel([]),
    t = token<number>("duplicate");
  k.services.provide(t, 1, "first");
  k.services.provide(t, 2, "second");
  expect(k.services.require(t, "test")).toBe(2);
});
/**
 * @case duplicate plugin ids silently discard one plugin
 * @preconditions Two plugin descriptors share one ID.
 * @expectedResult Only the first descriptor applies.
 */
test("duplicate plugin ids silently discard one plugin", async () => {
  const ran: string[] = [];
  const k = new Kernel([
    {
      id: "same",
      apply: () => {
        ran.push("one");
      },
    },
    {
      id: "same",
      apply: () => {
        ran.push("two");
      },
    },
  ]);
  await k.start();
  expect(ran).toEqual(["one"]);
});
/**
 * @case failing apply leaks its own stop and does not automatically unwind prior plugins
 * @preconditions Plugin a applies and plugin b throws in apply.
 * @expectedResult No automatic cleanup runs; explicit stop only stops a.
 */
test("failing apply leaks its own stop and does not automatically unwind prior plugins", async () => {
  const stopped: string[] = [];
  const k = new Kernel([
    {
      id: "a",
      stop: () => {
        stopped.push("a");
      },
    },
    {
      id: "b",
      apply: () => {
        throw Error("boom");
      },
      stop: () => {
        stopped.push("b");
      },
    },
  ]);
  await expect(k.start()).rejects.toThrow("boom");
  expect(stopped).toEqual([]);
  await k.stop();
  expect(stopped).toEqual(["a"]);
});
/**
 * @case one throwing disposer prevents all subsequent cleanup
 * @preconditions An applied plugin registers a throwing disposer and a stop hook.
 * @expectedResult Stop rejects and never reaches the stop hook.
 */
test("one throwing disposer prevents all subsequent cleanup", async () => {
  let stopped = false;
  const k = new Kernel([
    {
      id: "a",
      apply: (c) =>
        c.onTeardown(() => {
          throw Error("cleanup");
        }),
      stop: () => {
        stopped = true;
      },
    },
  ]);
  await k.start();
  await expect(k.stop()).rejects.toThrow("cleanup");
  expect(stopped).toBe(false);
});
/**
 * @case disposers close dependencies before dependent stop hooks
 * @preconditions A provider registers disposal and a dependent uses it in stop.
 * @expectedResult The dependent sees the provider already closed.
 */
test("disposers close dependencies before dependent stop hooks", async () => {
  let open = true,
    sawOpen = true;
  const k = new Kernel([
    {
      id: "store",
      apply: (c) =>
        c.onTeardown(() => {
          open = false;
        }),
    },
    {
      id: "client",
      dependsOn: ["store"],
      stop: () => {
        sawOpen = open;
      },
    },
  ]);
  await k.start();
  await k.stop();
  expect(sawOpen).toBe(false);
});
/**
 * @case observation can prevent execution entirely
 * @preconditions An exchange-started observer throws.
 * @expectedResult Deliver rejects with the observer error before running the pipeline.
 */
test("observation can prevent execution entirely", async () => {
  const k = new Kernel([
    {
      id: "observer",
      apply: (c) => {
        c.on("exchange:started", () => {
          throw Error("observer");
        });
      },
    },
  ]);
  await k.start();
  await expect(new Runtime(k).deliver(spec(), "body")).rejects.toThrow(
    "observer",
  );
});
/**
 * @case freeze does not freeze contributed descriptor data
 * @preconditions A contributed wrapper object is mutated after kernel start.
 * @expectedResult Delivery executes the changed wrapper despite registry freeze.
 */
test("freeze does not freeze contributed descriptor data", async () => {
  const w: WrapperContribution = { kind: "wrapper", id: "w", wrap: (n) => n };
  const k = new Kernel([{ id: "w", apply: (c) => c.contribute(w) }]);
  await k.start();
  w.wrap = () => async () => {
    throw Error("mutated after freeze");
  };
  await expect(new Runtime(k).deliver(spec(), 0)).rejects.toThrow(
    "mutated after freeze",
  );
});
/**
 * @case wrapper route-scoped state resets on every delivery
 * @preconditions A wrapper allocates its quota counter inside wrap.
 * @expectedResult Two deliveries create two counters and both pass.
 */
test("wrapper route-scoped state resets on every delivery", async () => {
  let constructions = 0;
  const k = new Kernel([
    {
      id: "limiter",
      apply: (c) =>
        c.contribute({
          kind: "wrapper",
          id: "limiter",
          wrap(next) {
            constructions++;
            let count = 0;
            return async (ex) => {
              if (++count > 1) throw Error("quota");
              await next(ex);
            };
          },
        }),
    },
  ]);
  await k.start();
  const r = new Runtime(k),
    route = spec();
  await r.deliver(route, 0);
  await r.deliver(route, 0);
  expect(constructions).toBe(2);
});
/**
 * @case defer does not halt and resume does not execute a continuation
 * @preconditions A route has a defer step followed by an effect.
 * @expectedResult The effect runs before approval and resume does not run a continuation.
 */
test("defer does not halt and resume does not execute a continuation", async () => {
  let effects = 0;
  const k = new Kernel([
    stores(),
    deferral(),
    {
      id: "effect",
      apply: (c) =>
        c.contribute({
          kind: "step",
          name: "effect",
          factory: () => ({
            label: "effect",
            run: () => {
              effects++;
            },
          }),
        }),
    },
  ]);
  await k.start();
  await new Runtime(k).deliver(spec([["defer", "approval"], ["effect"]]), 0);
  expect(effects).toBe(1);
  const api = k.services.require(DEFERRAL_API, "test");
  const [id] = await api.waiting();
  await api.resume(id!);
  expect(effects).toBe(1);
});
/**
 * @case derived builder build name produces a compiling runtime failure
 * @preconditions A typed plugin contributes a method named build.
 * @expectedResult The derived builder allows chained build calls that throw at runtime.
 */
test("derived builder build name produces a compiling runtime failure", () => {
  const p = {
    id: "p",
    steps: { build: () => ({ label: "x", run: () => {} }) },
  } satisfies TypedPlugin;
  const b = derivedBuilder([p]);
  expect(() => b.build().build()).toThrow(TypeError);
});
/**
 * @case merged bodyType is itself a false runtime return type
 * @preconditions Encoding C constructs a string-typed chain.
 * @expectedResult bodyType is typed string but returns undefined.
 */
test("merged bodyType is itself a false runtime return type", () => {
  const value: string = chain<string>().bodyType();
  expect(value).toBeUndefined();
});
/**
 * @case CAS test in baseline is sequential; true concurrent mock resumes still give one winner
 * @preconditions Two resume calls overlap on one waiting record.
 * @expectedResult Exactly one wins in the in-memory implementation.
 */
test("CAS test in baseline is sequential; true concurrent mock resumes still give one winner", async () => {
  const k = new Kernel([stores(), deferral()]);
  await k.start();
  await new Runtime(k).deliver(spec([["defer"]]), 0);
  const api = k.services.require(DEFERRAL_API, "test");
  const [id] = await api.waiting();
  expect(await Promise.all([api.resume(id!), api.resume(id!)])).toEqual([
    true,
    false,
  ]);
});
/**
 * @case memory store reads expose mutable state without a CAS
 * @preconditions A caller reads a stored object and mutates it.
 * @expectedResult The mutation changes the stored value without advancing its version.
 */
test("memory store reads expose mutable state without a CAS", async () => {
  const k = new Kernel([stores()]);
  await k.start();
  const s = k.services.require(STORE_API, "test").open("x");
  await s.put("k", { v: 1 });
  const row = await s.get("k");
  (row!.value as { v: number }).v = 9;
  expect((await s.get("k"))?.value).toEqual({ v: 9 });
  expect((await s.get("k"))?.version).toBe(1);
});
/**
 * @case timeout reports failure but abandoned execution continues
 * @preconditions A timeout races a step held behind an explicit gate.
 * @expectedResult The route fails on timeout; releasing the gate still causes the side effect.
 */
test("timeout reports failure but abandoned execution continues", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((r) => {
    finish = r;
  });
  let effect = false;
  const k = new Kernel([
    resilience(),
    {
      id: "slow",
      apply: (c) =>
        c.contribute({
          kind: "step",
          name: "slow",
          factory: () => ({
            label: "slow",
            run: async () => {
              await gate;
              effect = true;
            },
          }),
        }),
    },
  ]);
  await k.start();
  await expect(
    new Runtime(k).deliver(
      { ...spec([["slow"]]), options: { "routecraft.timeout": 1 } },
      0,
    ),
  ).rejects.toThrow("timeout");
  expect(effect).toBe(false);
  finish();
  await new Promise((r) => setTimeout(r, 0));
  expect(effect).toBe(true);
});
/** A real missing plugin: deadline-aware admission before parsing, then durable
 * halt/resume at a specific instruction. None of its required control ports exist. */
function durableAdmission(ctx: PluginContext) {
  // @ts-expect-error no pre-parse lifecycle point
  ctx.contribute({
    kind: "handler",
    id: "admit",
    point: "beforeParse",
    handle: () => {},
  });
  // @ts-expect-error no public dispatcher/continuation resume port
  ctx.resume({ routeId: "r", instruction: "after-approval", state: {} });
}
void durableAdmission;
/**
 * @case crash between record and index write leaves a deferral invisible to waiting
 * @preconditions The backend saves the primary record but rejects its index write.
 * @expectedResult Defer rejects and waiting omits the persisted record.
 */
test("crash between record and index write leaves a deferral invisible to waiting", async () => {
  const rows = new Map<string, { value: unknown; version: number }>();
  const store: Plugin = {
    id: "routecraft.stores",
    apply: (c) =>
      c.provide(STORE_API, {
        namespaces: () => ["deferral"],
        open: () => ({
          get: async (k) => rows.get(k),
          put: async (k, v) => {
            if (k.startsWith("idx/")) throw Error("crash before index");
            rows.set(k, { value: v, version: 1 });
            return { won: true };
          },
          list: async (p) => [...rows.keys()].filter((k) => k.startsWith(p)),
        }),
      }),
  };
  const k = new Kernel([store, deferral()]);
  await k.start();
  const api = k.services.require(DEFERRAL_API, "test");
  await expect(
    api.defer(
      { id: "x", routeId: "r", body: 0, headers: {}, use: () => undefined },
      "approval",
    ),
  ).rejects.toThrow("crash");
  expect(rows.has("deferral/def-1")).toBe(true);
  expect(await api.waiting()).toEqual([]);
});
/**
 * @case resume leaves an index tombstone rather than deleting the key
 * @preconditions A waiting deferral is resumed successfully.
 * @expectedResult Its index key remains present as a tombstone.
 */
test("resume leaves an index tombstone rather than deleting the key", async () => {
  const k = new Kernel([stores(), deferral()]);
  await k.start();
  await new Runtime(k).deliver(spec([["defer"]]), 0);
  const api = k.services.require(DEFERRAL_API, "test");
  const [id] = await api.waiting();
  await api.resume(id!);
  const store = k.services.require(STORE_API, "test").open("deferral");
  expect(await store.list("idx/waiting/")).toEqual([`idx/waiting/${id}`]);
});
/**
 * @case a failing error handler replaces the primary failure and prevents later handlers
 * @preconditions A failing step has two error handlers; the first throws.
 * @expectedResult The secondary error replaces the original and the later handler is skipped.
 */
test("a failing error handler replaces the primary failure and prevents later handlers", async () => {
  let later = false;
  const k = new Kernel([
    {
      id: "handlers",
      apply: (c) => {
        c.contribute({
          kind: "step",
          name: "fail-primary",
          factory: () => ({
            label: "primary",
            run: () => {
              throw Error("primary");
            },
          }),
        });
        c.contribute({
          kind: "handler",
          id: "first",
          point: "error",
          handle: () => {
            throw Error("secondary");
          },
        });
        c.contribute({
          kind: "handler",
          id: "later",
          point: "error",
          handle: () => {
            later = true;
          },
        });
      },
    },
  ]);
  await k.start();
  await expect(
    new Runtime(k).deliver(spec([["fail-primary"]]), 0),
  ).rejects.toThrow("secondary");
  expect(later).toBe(false);
});
/**
 * @case duplicate wrapper ids silently discard one contribution
 * @preconditions Two wrapper contributions share an ID.
 * @expectedResult Ordering returns only one wrapper.
 */
test("duplicate wrapper ids silently discard one contribution", async () => {
  const k = new Kernel([
    {
      id: "wrappers",
      apply: (c) => {
        c.contribute({ kind: "wrapper", id: "same", wrap: (n) => n });
        c.contribute({ kind: "wrapper", id: "same", wrap: (n) => n });
      },
    },
  ]);
  await k.start();
  expect(k.interventions.orderedWrappers()).toHaveLength(1);
});
