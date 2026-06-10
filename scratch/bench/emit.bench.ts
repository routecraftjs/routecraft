/**
 * Event-emit hot-path micro-benchmark.
 *
 * Simulates a telemetry-style subscription profile (wildcard + globstar +
 * exact handlers) and measures ops/sec for emitting a per-step event,
 * which is the highest-frequency emit in the framework (2 events per step
 * per exchange). Run before and after the event identity redesign.
 *
 * Usage: bun scratch/bench/emit.bench.ts
 */
import { ContextBuilder } from "@routecraft/routecraft";

const ITERATIONS = 200_000;

const { context } = await new ContextBuilder().build();

let hits = 0;
const handler = () => {
  hits++;
};

// Realistic subscription mix: a telemetry-style globstar, two scoped
// wildcards, an unrelated wildcard, and two exact handlers.
context.on("route:**", handler);
context.on("route:*:exchange:failed", handler);
context.on("route:*:step:completed", handler);
context.on("context:*", handler);
context.on("route:orders:step:completed", handler);
context.on("context:started", handler);

const details = {
  routeId: "orders",
  exchangeId: "ex-1",
  correlationId: "corr-1",
  operation: "transform",
  duration: 1,
};

// Warmup
for (let i = 0; i < 10_000; i++) {
  context.emit("route:orders:step:completed", details);
}

hits = 0;
const start = Bun.nanoseconds();
for (let i = 0; i < ITERATIONS; i++) {
  context.emit("route:orders:step:completed", details);
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
