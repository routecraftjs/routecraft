import {
  defineProject,
  direct,
  noop,
  when,
  otherwise,
  type Enricher,
  type Exchange,
} from "../../../src/index.ts";
import { plugins, type Order } from "./plugins.ts";

/**
 * A fetch-only factory whose body type reaches its callback only through
 * the contextual return type, the shape of `llm()` and `agent()`: what the
 * Enricher-first `.to()` overload resolves on the hot path.
 */
function lookup<T = unknown>(options: {
  key: (exchange: Exchange<T>) => string;
}): Enricher<T, { found: boolean }> {
  return {
    fetch: async (exchange) => ({ found: options.key(exchange) !== "" }),
  };
}

const project = defineProject({ plugins, deferral: { store: "memory" } });

export const route = project
  .craft()
  .id("budget")
  .from<Order>(direct())
  .alphaKeep((order) => order.id)
  .bravoOrder(0.1)
  .charlieKeep((order) => `${order.rate}`)
  .deltaOrder(0.2)
  .transform((order, ex) => ({ ...order, tenant: ex.echo.name }))
  .foxtrotKeep((order) => order.tenant)
  .choice<Order & { readonly rate: number }>(
    when(
      (ex) => ex.body.total > 10,
      (b) => b.golfOrder(0.3).hotelKeep((order) => order.id),
    ),
    otherwise((b) => b.indiaOrder(0)),
  )
  .defer()
  .julietKeep((order) => order.id)
  .authenticate(() => undefined)
  .delegate((ex) => {
    void ex.auth.principal;
    void ex.echo.name;
    return undefined;
  })
  .to(lookup({ key: (ex) => ex.body.id }))
  .to(noop());
