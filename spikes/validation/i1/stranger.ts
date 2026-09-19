/**
 * I1 says a third party cannot write a server plugin, because
 * `WEB_INGRESSES` is private. It is unexported, but it is
 * `Symbol.for("routecraft.plugin.server.web-ingresses")`, a process-global
 * string-keyed registry, and `getStore`/`setStore` are public methods on the
 * exported `CraftContext`. So the key is re-derivable from outside with no
 * private import, using only the published entry point.
 *
 * This file establishes whether the barrier is a capability barrier or a
 * documentation barrier. It imports nothing but "@routecraft/routecraft".
 */
import type { CraftContext, WebIngress } from "@routecraft/routecraft";

const WEB_INGRESSES: unique symbol = Symbol.for(
  "routecraft.plugin.server.web-ingresses",
) as typeof WEB_INGRESSES;

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [WEB_INGRESSES]: ReadonlyMap<string, WebIngress>;
  }
}

/** A stranger's server plugin, publishing the registry the first party publishes. */
export function acmeServers(ingresses: ReadonlyMap<string, WebIngress>) {
  return {
    name: "acme.servers",
    apply(ctx: CraftContext): void {
      ctx.setStore(WEB_INGRESSES, ingresses);
    },
  };
}

export function readBack(
  ctx: CraftContext,
): ReadonlyMap<string, WebIngress> | undefined {
  return ctx.getStore(WEB_INGRESSES);
}
