import { definePlugin, step, type Body } from "../../../src/index.ts";

interface Order {
  readonly id: string;
  readonly total: number;
}

/** Ten plugins with two steps each: the shape a mid-sized project installs. */
function stepsFor<const N extends string>(name: N) {
  return definePlugin({
    id: `budget.${name}`,
    steps: {
      [`${name}Keep`]: (key: (body: Body) => string) =>
        step<Body, Body>((exchange) => {
          key(exchange.body);
          return exchange.body;
        }),
      [`${name}Order`]: (rate: number) =>
        step<Order, Order & { readonly rate: number }>((exchange) => ({
          ...exchange.body,
          rate,
        })),
    } as {
      [K in `${N}Keep`]: (
        key: (body: Body) => string,
      ) => ReturnType<typeof step<Body, Body>>;
    } & {
      [K in `${N}Order`]: (
        rate: number,
      ) => ReturnType<typeof step<Order, Order & { readonly rate: number }>>;
    },
    facet: () => ({ name }),
  });
}

export const plugins = [
  stepsFor("alpha"),
  stepsFor("bravo"),
  stepsFor("charlie"),
  stepsFor("delta"),
  stepsFor("echo"),
  stepsFor("foxtrot"),
  stepsFor("golf"),
  stepsFor("hotel"),
  stepsFor("india"),
  stepsFor("juliet"),
] as const;

export type { Order };
