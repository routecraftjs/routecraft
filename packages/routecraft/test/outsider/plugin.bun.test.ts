import { afterEach, describe, expect, test } from "bun:test";
import {
  craft,
  definePlugin,
  defineProject,
  direct,
  lookupOf,
  noop,
  port,
  step,
  type Destination,
} from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";

interface Order {
  readonly id: string;
  readonly total: number;
}

interface Rates {
  rateFor(order: Order): number;
}

const RATES = port<Rates>("acme.rates@1");

const rates = definePlugin({
  id: "acme.rates",
  provides: [RATES],
  bind(c) {
    c.provide(RATES, { rateFor: () => 0.21 });
  },
});

let seenRate: number | undefined;

const pricing = definePlugin({
  id: "acme.pricing",
  requires: [RATES],
  bind(c) {
    seenRate = c.require(RATES).rateFor({ id: "probe", total: 0 });
  },
  steps: {
    withTax: (rate: number) =>
      step<Order, Order & { readonly gross: number }>((exchange) => ({
        ...exchange.body,
        gross: Math.round(exchange.body.total * (1 + rate)),
      })),
  },
});

describe("outsider: a plugin built on the published entry", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    await t?.stop();
    t = undefined;
    seenRate = undefined;
  });

  /**
   * @case A third-party plugin adds a typed step and reads another plugin's port
   * @preconditions Two plugins defined with package-name imports only; a project installs both and a route uses the step
   * @expectedResult The consumer binds after the provider and reads its port; the step runs on the route and its result reaches the caller
   */
  test("adds a step and requires a port", async () => {
    const project = defineProject({ plugins: [pricing, rates] });
    const route = project
      .craft()
      .id("orders")
      .from(direct<Order>())
      .withTax(0.21)
      .to(noop());

    t = await testContext().with(project.config).routes(route).build();
    await t.startAndWaitReady();

    const result = await t.client.sendDirect("orders", {
      id: "o-1",
      total: 100,
    });

    expect(seenRate).toBe(0.21);
    expect(result).toEqual({ id: "o-1", total: 100, gross: 121 });
  });

  /**
   * @case A third-party adapter reads a port off the exchange it is handed, and gets the plugin that replaced it
   * @preconditions A destination that calls lookupOf(exchange, RATES); one application installs the provider, a second also installs a plugin that replaces the port, and a third installs neither
   * @expectedResult Each exchange is priced by its own application's provider, the replacement where one is installed, and the adapter reads undefined where nothing provides the port
   */
  test("an adapter reads a port by exchange", async () => {
    const seen: Array<number | undefined> = [];
    const quote: Destination<Order> = {
      adapterId: "acme.quote",
      async send(exchange) {
        seen.push(lookupOf(exchange, RATES)?.rateFor(exchange.body));
      },
    };
    const reduced = definePlugin({
      id: "acme.reduced-rates",
      provides: [RATES],
      replaces: [RATES],
      bind(c) {
        c.provide(RATES, { rateFor: () => 0.09 });
      },
    });
    const quoted = async (
      plugins: NonNullable<Parameters<typeof defineProject>[0]["plugins"]>,
    ) => {
      const context = await testContext()
        .with(defineProject({ plugins }).config)
        .routes(craft().id("quotes").from(direct<Order>()).to(quote))
        .build();
      await context.startAndWaitReady();
      try {
        await context.client.sendDirect("quotes", { id: "o-1", total: 100 });
      } finally {
        await context.stop();
      }
    };

    await quoted([rates]);
    await quoted([rates, reduced]);
    await quoted([]);

    expect(seen).toEqual([0.21, 0.09, undefined]);
  });
});
