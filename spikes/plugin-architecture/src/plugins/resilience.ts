import type { Plugin } from "../contracts/index.ts";

/**
 * The pre-from chain, as ordered contributions rather than a fixed list
 * compiled into the executor.
 *
 * The constraints reproduce today's documented order
 * (error -> retry -> timeout -> concurrency), and nothing about that order
 * is known to core.
 */
export function resilience(): Plugin {
  return {
    id: "routecraft.resilience",
    apply(ctx) {
      ctx.contribute({
        kind: "wrapper",
        id: "routecraft.retry",
        after: ["routecraft.error"],
        wrap: (next, route) => async (exchange) => {
          const attempts = Number(route.optionsFor("routecraft.retry") ?? 1);
          let last: unknown;
          for (let i = 0; i < attempts; i++) {
            try {
              await next(exchange);
              return;
            } catch (error) {
              last = error;
            }
          }
          throw last;
        },
      });

      ctx.contribute({
        kind: "wrapper",
        id: "routecraft.timeout",
        after: ["routecraft.retry"],
        wrap: (next, route) => async (exchange) => {
          const ms = route.optionsFor("routecraft.timeout");
          if (typeof ms !== "number") return next(exchange);
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              next(exchange),
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("timeout")), ms);
              }),
            ]);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        },
      });

      ctx.contribute({
        kind: "wrapper",
        id: "routecraft.concurrency",
        after: ["routecraft.timeout"],
        wrap: (next) => next,
      });
    },
  };
}
