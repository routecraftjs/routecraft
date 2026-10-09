import {
  defineProject,
  direct,
  noop,
  when,
  otherwise,
} from "../../../src/index.ts";
import { plugins, type Order } from "./plugins.ts";

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
  .to(noop());
