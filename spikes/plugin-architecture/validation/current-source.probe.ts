/* eslint-disable no-console -- this executable audit reports reproducible measurements. */
import assert from "node:assert/strict";
import {
  CraftContext,
  requireWebIngress,
  registerDsl,
  craft,
  OperationType,
  type WebIngress,
  type BuilderState,
  type Source,
} from "@routecraft/routecraft";
import { claimDatabasePath } from "../../../packages/routecraft/src/shared/sqlite/claims.ts";
const externalKey: unique symbol = Symbol.for(
  "routecraft.plugin.server.web-ingresses",
);
declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [externalKey]: ReadonlyMap<string, WebIngress>;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- augmentation must match the original type parameters
  interface StepBuilderBase<S extends BuilderState> {
    astraBranch(): this;
  }
}
const ingress: WebIngress = {
  serverName: "default",
  resolveMountAuth: () => ({
    configured: false,
    own: false,
    optedOut: false,
    walled: false,
  }),
  hasMount: () => false,
  boundAddress: undefined,
  mountHttp: () => () => {},
};
const ctx = new CraftContext();
ctx.setStore(externalKey, new Map([["default", ingress]]));
assert.equal(requireWebIngress(ctx), ingress);
console.log(
  "I1: replacement lookup works by recreating the private Symbol.for name (unsupported protocol, public imports only)",
);
registerDsl("astraBranch", {
  kind: "tap",
  label: "branch-through-sugar",
  factory: () => ({
    operation: OperationType.PROCESS,
    adapter: {},
    execute: async (exchange) => ({ kind: "complete", exchange }),
  }),
});
const source: Source<string> = { subscribe: async () => {} };
const definition = craft().id("probe").from(source).astraBranch().build();
assert.equal(definition[0]?.steps[0]?.operation, OperationType.PROCESS);
console.log(
  "I2/D11: registerDsl accepts a custom early-complete Step despite kind tap; kind does not restrict factory behavior",
);
const plain = new CraftContext();
await plain.start();
await plain.stop();
console.log("I8: context starts/stops with no deferral configured");
const scope = {};
claimDatabasePath({
  scope,
  path: "/private/tmp/probe.db",
  claimant: "a",
  onConflict: () => Error("conflict"),
});
assert.throws(
  () =>
    claimDatabasePath({
      scope,
      path: "/private/tmp/probe.db",
      claimant: "b",
      onConflict: () => Error("conflict"),
    }),
  /conflict/,
);
console.log("I5: same-context database path conflict rejected");
