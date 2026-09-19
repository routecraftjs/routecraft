import type { Plugin, Step } from "../contracts/index.ts";

/**
 * Main's operations, contributed through the same door a stranger uses.
 * Today roughly seventy of these are hard-coded builder class methods.
 */
export function operations(): Plugin {
  return {
    id: "routecraft.operations",
    apply(ctx) {
      ctx.contribute({
        kind: "step",
        name: "transform",
        factory: (...args) => {
          const fn = args[0] as (body: unknown) => unknown;
          return {
            label: "transform",
            run: (ex) => void (ex.body = fn(ex.body)),
          } satisfies Step;
        },
      });
      ctx.contribute({
        kind: "step",
        name: "tap",
        factory: (...args) => {
          const fn = args[0] as (body: unknown) => void;
          return { label: "tap", run: (ex) => fn(ex.body) } satisfies Step;
        },
      });
      ctx.contribute({
        kind: "step",
        name: "fail",
        factory: (...args) => {
          const message = args[0] as string;
          return {
            label: "fail",
            run: () => {
              throw new Error(message);
            },
          } satisfies Step;
        },
      });
    },
  };
}
