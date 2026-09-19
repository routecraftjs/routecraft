import type { Plugin } from "../src/contracts/index.ts";
export const durableAdmission: Plugin = {
  id: "acme.durable-admission",
  apply(ctx) {
    ctx.contribute({
      kind: "handler",
      id: "admit",
      point: "beforeParse",
      handle: () => {},
    });
    ctx.resume({ routeId: "r", instruction: "after-approval", state: {} });
  },
};
export const eventPublisher: Plugin = {
  id: "acme.events",
  apply(ctx) {
    ctx.emit("acme:progress", { completed: 1 });
  },
};
