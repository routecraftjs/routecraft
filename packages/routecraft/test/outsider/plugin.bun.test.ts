import { afterEach, describe, expect, test } from "bun:test";
import {
  definePlugin,
  defineProject,
  direct,
  noop,
  port,
  step,
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
});
