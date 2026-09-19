/* eslint-disable no-console -- printing the composed plugin order to a
   terminal is this file's entire purpose; nothing in this spike ships. */
import { Kernel } from "./kernel/index.ts";
import { Runtime, type RouteSpec } from "./runtime/index.ts";
import { operations } from "./plugins/operations.ts";
import { resilience } from "./plugins/resilience.ts";
import { stores } from "./plugins/stores.ts";
import { deferral, DEFERRAL_API } from "./plugins/deferral.ts";
import { telemetry } from "./plugins/telemetry.ts";
import { audit } from "./plugins/audit.ts";

const events: string[] = [];
const auditLog: string[] = [];

const kernel = new Kernel([
  audit(auditLog),
  deferral(),
  telemetry(events),
  operations(),
  resilience(),
  stores(),
]);

console.log("install order:", kernel.order.join(" -> "));
await kernel.start();
console.log(
  "wrapper chain:",
  kernel.interventions
    .orderedWrappers()
    .map((w) => w.id)
    .join(" -> "),
);
console.log("steps:", kernel.interventions.stepNames().join(", "));

const spec: RouteSpec = {
  id: "greet",
  source: { label: "manual", subscribe: () => Promise.resolve(() => {}) },
  steps: [
    ["auditMark"],
    ["transform", (b: unknown) => `hello ${String(b)}`],
    ["defer", "needs approval"],
  ],
  options: { "routecraft.retry": 2 },
};

const exchange = await new Runtime(kernel).deliver(spec, "world");
console.log("body:", exchange.body);
console.log("audit:", auditLog.join(" | "));
console.log(
  "waiting deferrals:",
  await kernel.services.require(DEFERRAL_API, "demo").waiting(),
);
console.log("health:", await kernel.health());
await kernel.stop();
console.log("events seen by telemetry:", events.length);
