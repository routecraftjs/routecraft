/**
 * End-to-end route throughput benchmark.
 *
 * Three scenarios exercising the pipeline engine:
 *  - plain:    direct -> 3 transforms -> noop (baseline step loop)
 *  - wrapped:  same with .error() on each transform (WrapperStep path)
 *  - splitAgg: direct -> split -> transform -> aggregate -> noop (fan-out/join)
 *
 * Sequential awaited sends measure full exchange lifecycle latency.
 * Run before and after the step-outcome contract rewrite (C1).
 *
 * Usage: bun scratch/bench/throughput.bench.ts
 */
import { ContextBuilder, craft, direct, noop } from "@routecraft/routecraft";

const SENDS = 5_000;
const SPLIT_SENDS = 1_000;

const routes = craft()
  .id("plain")
  .from(direct())
  .transform((b) => (b as number) + 1)
  .transform((b) => (b as number) * 2)
  .transform((b) => `${b}`)
  .to(noop())

  .id("wrapped")
  .from(direct())
  .error(() => -1)
  .transform((b) => (b as number) + 1)
  .error(() => -1)
  .transform((b) => (b as number) * 2)
  .error(() => "recovered")
  .transform((b) => `${b}`)
  .to(noop())

  .id("split-agg")
  .from(direct())
  .split()
  .transform((b) => (b as number) + 1)
  .aggregate()
  .to(noop());

const builder = new ContextBuilder();
builder.routes(routes);
const { context, client } = await builder.build();
void context.start();

async function bench(
  name: string,
  sends: number,
  body: () => unknown,
): Promise<void> {
  // Warmup
  for (let i = 0; i < Math.min(200, sends); i++) {
    await client.send(name, body());
  }
  const start = Bun.nanoseconds();
  for (let i = 0; i < sends; i++) {
    await client.send(name, body());
  }
  const elapsedNs = Bun.nanoseconds() - start;
  const perSec = sends / (elapsedNs / 1e9);
  console.log(
    `${name.padEnd(10)} ${sends} sends in ${(elapsedNs / 1e6).toFixed(0).padStart(6)} ms  ` +
      `${Math.round(perSec).toLocaleString().padStart(8)} exchanges/sec  ` +
      `${(elapsedNs / sends / 1e3).toFixed(1)} us/exchange`,
  );
}

await bench("plain", SENDS, () => 1);
await bench("wrapped", SENDS, () => 1);
await bench("split-agg", SPLIT_SENDS, () => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

await context.stop();
