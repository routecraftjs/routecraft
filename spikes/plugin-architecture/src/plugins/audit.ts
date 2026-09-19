import type { Plugin } from "../contracts/index.ts";
import { STORE_API } from "./stores.ts";

/**
 * A stranger's plugin. Not shipped by the framework, written against the
 * published contracts only, and it does three things no third party can do
 * today: insert a wrapper into the middle of the resilience chain, depend
 * on a first-party plugin's API, and contribute a step.
 *
 * If this file compiles and its test passes, P1 holds for this surface.
 */
export function audit(log: string[]): Plugin {
  return {
    id: "acme.audit",
    dependsOn: ["routecraft.stores"],

    apply(ctx) {
      const store = ctx.require(STORE_API).open("acme-audit");

      ctx.contribute({
        kind: "wrapper",
        id: "acme.audit",
        after: ["routecraft.retry"],
        before: ["routecraft.timeout"],
        wrap: (next, route) => async (exchange) => {
          log.push(`enter ${route.id}`);
          await store.put(`seen/${exchange.id}`, Date.now());
          await next(exchange);
          log.push(`exit ${route.id}`);
        },
      });

      ctx.contribute({
        kind: "step",
        name: "auditMark",
        factory: () => ({
          label: "auditMark",
          run: (ex) => void (ex.headers["acme-audit"] = true),
        }),
      });
    },
  };
}
