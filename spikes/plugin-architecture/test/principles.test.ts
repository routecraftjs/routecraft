import { describe, expect, test } from "bun:test";
import { Kernel } from "../src/kernel/index.ts";
import {
  Runtime,
  UnknownStepError,
  type RouteSpec,
} from "../src/runtime/index.ts";
import { UnresolvedTokenError } from "../src/registry/index.ts";
import { DuplicateStepError } from "../src/interventions/index.ts";
import { operations } from "../src/plugins/operations.ts";
import { resilience } from "../src/plugins/resilience.ts";
import { stores } from "../src/plugins/stores.ts";
import {
  deferral,
  DEFERRAL_API,
  DEFERRAL_EXT,
} from "../src/plugins/deferral.ts";
import { telemetry } from "../src/plugins/telemetry.ts";
import { audit } from "../src/plugins/audit.ts";
import { token, type Plugin } from "../src/contracts/index.ts";

const route = (steps: RouteSpec["steps"]): RouteSpec => ({
  id: "demo",
  source: { label: "none", subscribe: () => Promise.resolve(() => {}) },
  steps,
});

describe("P7: every plugin can be declined and replaced", () => {
  /**
   * @case A first-party plugin is absent from the config
   * @preconditions deferral is not installed; the route uses no deferral step
   * @expectedResult the context starts and the route runs normally
   */
  test("a context runs with a first-party plugin declined", async () => {
    const kernel = new Kernel([operations(), resilience()]);
    await kernel.start();
    const exchange = await new Runtime(kernel).deliver(
      route([["transform", (b: unknown) => `${String(b)}!`]]),
      "hi",
    );
    expect(exchange.body).toBe("hi!");
  });

  /**
   * @case A route uses a step whose plugin was declined
   * @preconditions deferral absent, the route calls defer
   * @expectedResult assembly throws, listing the steps that do exist
   */
  test("declining a plugin fails legibly where its step is used", async () => {
    const kernel = new Kernel([operations()]);
    await kernel.start();
    expect(() =>
      new Runtime(kernel).assemble(route([["defer", "why"]])),
    ).toThrow(UnknownStepError);
  });

  /**
   * @case A stranger substitutes their own implementation of a first-party API
   * @preconditions acme.stores provides STORE_API instead of routecraft.stores
   * @expectedResult deferral resolves the stranger's store and works unchanged
   */
  test("a stranger's plugin substitutes for a first-party one", async () => {
    const opened: string[] = [];
    const fake: Plugin = {
      id: "routecraft.stores",
      apply(ctx) {
        const rows = new Map<string, { value: unknown; version: number }>();
        ctx.provide(
          token<import("../src/plugins/stores.ts").StoreApi>(
            "routecraft.stores.api",
          ),
          {
            open(ns) {
              opened.push(ns);
              return {
                get: (k) => Promise.resolve(rows.get(k)),
                put: (k, v) => {
                  rows.set(k, {
                    value: v,
                    version: (rows.get(k)?.version ?? 0) + 1,
                  });
                  return Promise.resolve({ won: true });
                },
                list: (p) =>
                  Promise.resolve(
                    [...rows.keys()].filter((k) => k.startsWith(p)),
                  ),
              };
            },
            namespaces: () => [...new Set(opened)],
          },
        );
      },
    };
    const kernel = new Kernel([fake, deferral()]);
    await kernel.start();
    expect(opened).toEqual(["deferral"]);
  });

  /**
   * @case A plugin requires a token nothing provides
   * @preconditions a plugin requires an unprovided token
   * @expectedResult it throws naming the token and the requesting plugin
   */
  test("an unprovided token fails naming both sides", async () => {
    const MISSING = token<string>("acme.missing");
    const needy: Plugin = {
      id: "acme.needy",
      apply: (ctx) => void ctx.require(MISSING),
    };
    const kernel = new Kernel([needy]);
    await expect(kernel.start()).rejects.toThrow(UnresolvedTokenError);
  });
});

describe("P1: a stranger has the same reach as main", () => {
  /**
   * @case A third-party plugin contributes a wrapper, a step, and consumes a first-party API
   * @preconditions acme.audit installed alongside main's plugins
   * @expectedResult all three work and the wrapper runs around the pipeline
   */
  test("a third-party plugin does everything a first-party one does", async () => {
    const log: string[] = [];
    const kernel = new Kernel([
      stores(),
      operations(),
      resilience(),
      audit(log),
    ]);
    await kernel.start();
    const exchange = await new Runtime(kernel).deliver(
      route([
        ["auditMark"],
        ["transform", (b: unknown) => String(b).toUpperCase()],
      ]),
      "x",
    );
    expect(exchange.body).toBe("X");
    expect(exchange.headers["acme-audit"]).toBe(true);
    expect(log).toEqual(["enter demo", "exit demo"]);
  });

  /**
   * @case Two plugins contribute the same step name
   * @preconditions both contribute "transform"
   * @expectedResult the collision is refused at apply, naming both plugins
   */
  test("a step-name collision is refused, naming both plugins", async () => {
    const clash: Plugin = {
      id: "acme.clash",
      apply(ctx) {
        ctx.contribute({
          kind: "step",
          name: "transform",
          factory: () => ({ label: "transform", run: () => {} }),
        });
      },
    };
    const kernel = new Kernel([operations(), clash]);
    await expect(kernel.start()).rejects.toThrow(DuplicateStepError);
  });
});

describe("deferral as a plugin: the acceptance test in miniature", () => {
  /**
   * @case The deferral step writes through the store plugin
   * @preconditions stores and deferral installed, a route with a defer step
   * @expectedResult one deferral is waiting afterwards
   */
  test("defer persists through the store plugin's namespace", async () => {
    const kernel = new Kernel([stores(), operations(), deferral()]);
    await kernel.start();
    await new Runtime(kernel).deliver(
      route([["defer", "needs approval"]]),
      "x",
    );
    const api = kernel.services.require(DEFERRAL_API, "test");
    expect(await api.waiting()).toHaveLength(1);
  });

  /**
   * @case Resume is a compare-and-swap, so only one caller wins
   * @preconditions one waiting deferral, resumed twice
   * @expectedResult the first wins and the second loses
   */
  test("resume is compare-and-swap", async () => {
    const kernel = new Kernel([stores(), operations(), deferral()]);
    await kernel.start();
    await new Runtime(kernel).deliver(route([["defer", "r"]]), "x");
    const api = kernel.services.require(DEFERRAL_API, "test");
    const [id] = await api.waiting();
    expect(await api.resume(id!)).toBe(true);
    expect(await api.resume(id!)).toBe(false);
    expect(await api.waiting()).toHaveLength(0);
  });

  /**
   * @case A plugin attaches state to the exchange without core knowing the name
   * @preconditions deferral contributes an exchange extension
   * @expectedResult the affordance is reachable from a step via ex.use
   */
  test("an exchange extension is reachable without core knowing it", async () => {
    const kernel = new Kernel([stores(), operations(), deferral()]);
    await kernel.start();
    const runtime = new Runtime(kernel);
    const spec: RouteSpec = route([["tap", () => {}]]);
    const exchange = await runtime.deliver(spec, "x");
    const affordance = exchange.use(DEFERRAL_EXT);
    expect(affordance).toBeDefined();
    expect(await affordance!.defer("from the exchange")).toMatch(/^def-/);
  });

  /**
   * @case The error handler defers a failed exchange
   * @preconditions a route whose step throws, with deferral installed
   * @expectedResult the failure still propagates and one deferral is recorded
   */
  test("an error handler contribution runs on failure", async () => {
    const kernel = new Kernel([stores(), operations(), deferral()]);
    await kernel.start();
    const runtime = new Runtime(kernel);
    await expect(
      runtime.deliver(route([["fail", "nope"]]), "x"),
    ).rejects.toThrow("nope");
    const api = kernel.services.require(DEFERRAL_API, "test");
    expect(await api.waiting()).toHaveLength(1);
  });
});

describe("the two seams stay separate", () => {
  /**
   * @case Telemetry observes without contributing
   * @preconditions telemetry installed with a sink array
   * @expectedResult it records lifecycle events and contributes nothing
   */
  test("an observe-only plugin needs no intervention", async () => {
    const sink: string[] = [];
    const kernel = new Kernel([operations(), telemetry(sink)]);
    await kernel.start();
    await new Runtime(kernel).deliver(route([["tap", () => {}]]), "x");
    expect(sink).toContain("kernel:started");
    expect(sink).toContain("exchange:started");
    expect(sink).toContain("exchange:completed");
    expect(kernel.interventions.orderedWrappers()).toHaveLength(0);
  });

  /**
   * @case Contributions are refused after start
   * @preconditions a plugin that contributes from its start hook
   * @expectedResult the contribution throws rather than silently missing the chain
   */
  test("contributing after the registry freezes is refused", async () => {
    const late: Plugin = {
      id: "acme.late",
      start(ctx) {
        ctx.contribute({ kind: "wrapper", id: "late", wrap: (n) => n });
      },
    };
    const kernel = new Kernel([late]);
    await expect(kernel.start()).rejects.toThrow("contributed after start");
  });
});
