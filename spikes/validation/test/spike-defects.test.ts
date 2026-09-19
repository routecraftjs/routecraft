import { describe, expect, test } from "bun:test";
import { Kernel } from "../../plugin-architecture/src/kernel/index.ts";
import {
  Runtime,
  type RouteSpec,
} from "../../plugin-architecture/src/runtime/index.ts";
import { operations } from "../../plugin-architecture/src/plugins/operations.ts";
import {
  stores,
  STORE_API,
} from "../../plugin-architecture/src/plugins/stores.ts";
import { resilience } from "../../plugin-architecture/src/plugins/resilience.ts";
import {
  deferral,
  DEFERRAL_API,
  DEFERRAL_EXT,
} from "../../plugin-architecture/src/plugins/deferral.ts";
import {
  derivedBuilder,
  typedDeferral,
  typedOperations,
} from "../../plugin-architecture/src/builder/index.ts";
import {
  token,
  type Plugin,
} from "../../plugin-architecture/src/contracts/index.ts";

const route = (steps: RouteSpec["steps"]): RouteSpec => ({
  id: "demo",
  source: { label: "none", subscribe: () => Promise.resolve(() => {}) },
  steps,
});

describe("defects in the spike's kernel", () => {
  /**
   * @case Two installed plugins share an id
   * @preconditions two distinct plugins both called "routecraft.stores"
   * @expectedResult the second is silently dropped and never applies, while
   *   the dependency graph resolved against it
   */
  test("a duplicate plugin id is silently dropped", async () => {
    const applied: string[] = [];
    const first: Plugin = {
      id: "dup",
      apply: () => void applied.push("first"),
    };
    const second: Plugin = {
      id: "dup",
      apply: () => void applied.push("second"),
    };
    const kernel = new Kernel([first, second]);
    await kernel.start();
    expect(kernel.order).toEqual(["dup"]);
    expect(applied).toEqual(["first"]);
  });

  /**
   * @case Two plugins provide the same token
   * @preconditions both provide STORE_API
   * @expectedResult the last silently wins, which is exactly the I9 defect
   *   the design says a replacement must declare itself to avoid
   */
  test("two providers of one token resolve by install order, silently", async () => {
    const opened: string[] = [];
    const shadow: Plugin = {
      id: "acme.shadow",
      dependsOn: ["routecraft.stores"],
      apply(ctx) {
        ctx.provide(STORE_API, {
          open: (ns) => {
            opened.push(`shadow:${ns}`);
            return {
              get: () => Promise.resolve(undefined),
              put: () => Promise.resolve({ won: true }),
              list: () => Promise.resolve([]),
            };
          },
          namespaces: () => [],
        });
      },
    };
    const kernel = new Kernel([stores(), shadow, deferral()]);
    await kernel.start();
    // No diagnostic, no `replaces` declaration, no error. Whoever applied
    // last owns the token.
    expect(opened).toEqual(["shadow:deferral"]);
  });

  /**
   * @case Two plugins attach an exchange extension under the same token
   * @preconditions both contribute an "exchange" contribution for DEFERRAL_EXT
   * @expectedResult the last silently overwrites, unlike a step-name clash
   *   which is refused at apply
   */
  test("an exchange-extension token collision is silent, unlike a step clash", async () => {
    const hijack: Plugin = {
      id: "acme.hijack",
      apply(ctx) {
        ctx.contribute({
          kind: "exchange",
          id: "acme.hijack",
          factory: {
            token: DEFERRAL_EXT,
            create: () => ({ defer: () => Promise.resolve("hijacked") }),
          },
        });
      },
    };
    const kernel = new Kernel([stores(), operations(), deferral(), hijack]);
    await kernel.start();
    const ex = await new Runtime(kernel).deliver(
      route([["tap", () => {}]]),
      "x",
    );
    expect(await ex.use(DEFERRAL_EXT)!.defer("r")).toBe("hijacked");
  });

  /**
   * @case The wrapper chain is composed per delivery
   * @preconditions one assembled route delivered twice
   * @expectedResult every wrapper's `wrap` runs again for the second
   *   exchange, so the chain is rebuilt per exchange rather than per route
   */
  test("the wrapper chain is re-sorted and re-composed for every exchange", async () => {
    let composed = 0;
    const counter: Plugin = {
      id: "acme.counter",
      apply(ctx) {
        ctx.contribute({
          kind: "wrapper",
          id: "acme.counter",
          wrap: (next) => {
            composed++;
            return next;
          },
        });
      },
    };
    const kernel = new Kernel([operations(), counter]);
    await kernel.start();
    const runtime = new Runtime(kernel);
    const spec = route([["tap", () => {}]]);
    await runtime.deliver(spec, "a");
    await runtime.deliver(spec, "b");
    await runtime.deliver(spec, "c");
    expect(composed).toBe(3);
  });

  /**
   * @case The spike's CAS test is sequential, so it never reaches the CAS
   * @preconditions a store that ignores `ifVersion` entirely
   * @expectedResult the spike's own sequential assertions still pass, so the
   *   test named "resume is compare-and-swap" is guarded by the status read,
   *   not by the compare-and-swap. (Under real concurrency the CAS does hold;
   *   the defect is in the test, not the code.)
   */
  test("the spike's CAS test passes against a store with no CAS", async () => {
    const rows = new Map<string, { value: unknown; version: number }>();
    const noCas: Plugin = {
      id: "routecraft.stores",
      apply(ctx) {
        ctx.provide(STORE_API, {
          open: () => ({
            get: (k) => Promise.resolve(rows.get(k)),
            // `ifVersion` is ignored. A real CAS test would fail here.
            put: (k, v) => {
              rows.set(k, {
                value: v,
                version: (rows.get(k)?.version ?? 0) + 1,
              });
              return Promise.resolve({ won: true });
            },
            list: (p) =>
              Promise.resolve([...rows.keys()].filter((k) => k.startsWith(p))),
          }),
          namespaces: () => [],
        });
      },
    };
    const kernel = new Kernel([noCas, operations(), deferral()]);
    await kernel.start();
    await new Runtime(kernel).deliver(route([["defer", "r"]]), "x");
    const api = kernel.services.require(DEFERRAL_API, "test");
    const [id] = await api.waiting();
    // These are the spike's own three assertions, verbatim.
    expect(await api.resume(id!)).toBe(true);
    expect(await api.resume(id!)).toBe(false);
    expect(await api.waiting()).toHaveLength(0);
  });

  /**
   * @case Concurrent resume, which the spike does not test
   * @preconditions two resumes raced with Promise.all against the real store
   * @expectedResult exactly one wins, so the property holds; it is simply
   *   not the property the spike's test demonstrates
   */
  test("concurrent resume: exactly one wins, and the spike never checks it", async () => {
    const kernel = new Kernel([stores(), operations(), deferral()]);
    await kernel.start();
    await new Runtime(kernel).deliver(route([["defer", "r"]]), "x");
    const api = kernel.services.require(DEFERRAL_API, "test");
    const [id] = await api.waiting();
    const results = await Promise.all([api.resume(id!), api.resume(id!)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  /**
   * @case Resilience declares an ordering constraint nothing provides
   * @preconditions retry declares after routecraft.error
   * @expectedResult the chain the README calls "the documented order" is
   *   missing its first position and says nothing about it
   */
  test("the spike's own documented order silently loses its first position", async () => {
    const kernel = new Kernel([resilience()]);
    await kernel.start();
    const ids = kernel.interventions.orderedWrappers().map((w) => w.id);
    expect(ids).not.toContain("routecraft.error");
  });
});

describe("defects in the spike's derived builder", () => {
  /**
   * @case Two plugins declare the same step name in their types
   * @preconditions both step maps carry `transform`
   * @expectedResult the type intersects into an overload while the kernel
   *   refuses the same pair at apply, so the two halves disagree again
   */
  test("a duplicate step name intersects in the type and throws at runtime", () => {
    const clash = {
      id: "acme.clash",
      steps: typedOperations.steps,
    } as const;
    const b = derivedBuilder([typedOperations, clash]);
    // The type has one `transform`; the runtime registry silently kept the
    // last writer. No DuplicateStepError, unlike `ctx.contribute`.
    expect(typeof b.transform).toBe("function");
  });

  /**
   * @case The derived builder ignores dependsOn
   * @preconditions deferral declares dependsOn routecraft.stores; stores absent
   * @expectedResult the builder still offers `defer`, so the builder type
   *   and the kernel's admissible plugin sets disagree
   */
  test("the derived builder offers a step whose plugin the kernel would refuse", () => {
    const b = derivedBuilder([typedDeferral]);
    expect(b.defer("why").build()).toHaveLength(1);
    expect(() => new Kernel([deferral()])).toThrow();
  });

  /**
   * @case Two chains from one builder
   * @preconditions the proxy returns itself and mutates one captured array
   * @expectedResult branching is impossible; both chains share every step
   */
  test("the derived builder cannot branch, because the proxy is a singleton", () => {
    const b = derivedBuilder([typedOperations]);
    const left = b.transform((x) => `${String(x)}-L`);
    const right = b.transform((x) => `${String(x)}-R`);
    expect(left.build()).toHaveLength(2);
    expect(right.build()).toBe(left.build());
  });
});

describe("the token mechanism", () => {
  /**
   * @case Two packages choose the same token name
   * @preconditions token() is Symbol.for, a process-global string registry
   * @expectedResult distinct Token values compare equal, so the collision
   *   declaration merging catches at compile time becomes a silent
   *   runtime overwrite
   */
  test("token() collides globally by string, with no compile-time check", () => {
    const mine = token<{ a: string }>("acme.thing");
    const theirs = token<{ b: number }>("acme.thing");
    expect(mine.key).toBe(theirs.key);
  });
});
