/**
 * Event-emit hot-path micro-benchmark (fixed-name event model).
 *
 * Simulates a telemetry-style subscription profile: one catch-all "*",
 * exact-name subscriptions, and a forRoute-filtered handler. Measures
 * ops/sec for emitting a per-step event, the highest-frequency emit in
 * the framework (2 events per step per exchange).
 *
 * Usage: bun scratch/bench/emit.bench.ts
 */
import { ContextBuilder, forRoute } from "@routecraft/routecraft";

const ITERATIONS = 200_000;

const { context } = await new ContextBuilder().build();

let hits = 0;
const handler = () => {
  hits++;
};

// Realistic subscription mix mirroring the old bench: a telemetry-style
// catch-all, two exact step/exchange subscriptions, an unrelated exact
// subscription, a forRoute-filtered handler, and one more exact handler.
context.on("*", handler);
context.on("route:exchange:failed", handler);
context.on("route:step:completed", handler);
context.on("context:started", handler);
context.on("route:step:completed", forRoute("orders", handler));
context.on("route:started", handler);

const details = {
  routeId: "orders",
  exchangeId: "ex-1",
  correlationId: "corr-1",
  operation: "transform",
  duration: 1,
};

// Warmup
for (let i = 0; i < 10_000; i++) {
  context.emit("route:step:completed", details);
}

hits = 0;
const start = Bun.nanoseconds();
for (let i = 0; i < ITERATIONS; i++) {
  context.emit("route:step:completed", details);
}
const elapsedNs = Bun.nanoseconds() - start;

const elapsedMs = elapsedNs / 1e6;
const opsPerSec = ITERATIONS / (elapsedNs / 1e9);

console.log(`emits:        ${ITERATIONS}`);
console.log(`handler hits: ${hits}`);
console.log(`elapsed:      ${elapsedMs.toFixed(1)} ms`);
console.log(
  `throughput:   ${Math.round(opsPerSec).toLocaleString()} emits/sec`,
);
console.log(`per emit:     ${(elapsedNs / ITERATIONS).toFixed(0)} ns`);

await context.stop();
