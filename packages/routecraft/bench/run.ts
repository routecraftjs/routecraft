/**
 * Micro-benchmarks for the costs a contract change can move: the exchange
 * hot path, the price of a listener, and route compilation.
 *
 * Wall-clock numbers from two separate runs differ by 10% or more on a
 * shared machine, which is larger than any budget worth holding. So the
 * harness loads two builds of the package into one process and alternates
 * between them round by round: both see the same machine in the same
 * minute, and the ratio is what gets judged.
 *
 * Usage, from the repo root after `bun run build`:
 *   bun packages/routecraft/bench/run.ts
 *       print ns/op for this checkout's build
 *   bun packages/routecraft/bench/run.ts --base ../main/packages/routecraft/dist/index.js
 *       compare against another checkout's build; exit 1 when a scenario
 *       is slower than its budget allows
 *   --head <path> names the build under test when it is not this checkout's
 */
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Api = typeof import("../src/index.ts");

interface Scenario {
  readonly name: string;
  /** Largest slowdown against the base, as a fraction, before the run fails. */
  readonly budget: number;
  /** Runs the scenario once on one build and returns nanoseconds per operation. */
  readonly measure: (api: Api) => Promise<number>;
}

const EXCHANGES = 10_000;
const ROUNDS = 21;
const STEPS_PER_ROUTE = 10;
const ROUTES = 20;

async function dispatch(api: Api, listener: boolean): Promise<number> {
  const route = api
    .craft()
    .id("bench")
    .from(api.direct<number>())
    .transform((n) => n + 1)
    .transform((n) => n + 1)
    .transform((n) => n + 1)
    .transform((n) => n + 1)
    .transform((n) => n + 1)
    .to(api.noop());
  const { context, client } = await new api.ContextBuilder()
    .routes(route)
    .build();
  if (listener) context.on("*", () => {});
  const running = context.start();
  await context.whenStarted();
  try {
    for (let i = 0; i < 1_000; i++) await client.sendDirect("bench", i);
    const started = performance.now();
    for (let i = 0; i < EXCHANGES; i++) await client.sendDirect("bench", i);
    return ((performance.now() - started) * 1e6) / EXCHANGES;
  } finally {
    await context.stop();
    await running;
  }
}

async function compile(api: Api): Promise<number> {
  const started = performance.now();
  const builder = new api.ContextBuilder();
  for (let r = 0; r < ROUTES; r++) {
    let route = api.craft().id(`corpus-${r}`).from(api.direct<number>());
    for (let s = 0; s < STEPS_PER_ROUTE; s++) {
      route = route.transform((n) => n + 1);
    }
    builder.routes(route.to(api.noop()));
  }
  const { context } = await builder.build();
  const running = context.start();
  await context.whenStarted();
  const elapsed = (performance.now() - started) * 1e6;
  await context.stop();
  await running;
  return elapsed / (ROUTES * STEPS_PER_ROUTE);
}

const SCENARIOS: Scenario[] = [
  {
    name: "exchange through 5 transforms, no listener",
    budget: 0.03,
    measure: (api) => dispatch(api, false),
  },
  {
    name: "exchange through 5 transforms, one * listener",
    budget: 0.05,
    measure: (api) => dispatch(api, true),
  },
  {
    name: "build and start, per step of a 200-step corpus",
    budget: 1,
    measure: compile,
  },
];

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function load(path: string, copy: string): Promise<Api> {
  // The query makes a second instance of a path already loaded.
  return (await import(`${pathToFileURL(resolve(path)).href}?${copy}`)) as Api;
}

// Two builds in one process trip the two-copy warning; it is not a result.
process.env["LOG_LEVEL"] ??= "silent";

const here = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const head = await load(flag("--head") ?? here, "head");
const basePath = flag("--base");
const base = basePath ? await load(basePath, "base") : undefined;

let failed = false;
const lines = base
  ? [
      "| Scenario | Base ns/op | Head ns/op | Change | Budget |",
      "| --- | ---: | ---: | ---: | ---: |",
    ]
  : ["| Scenario | ns/op |", "| --- | ---: |"];

for (const scenario of SCENARIOS) {
  const heads: number[] = [];
  const bases: number[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    // Alternate which build goes first, so neither always runs on the
    // warmer process.
    if (base && round % 2 === 0) bases.push(await scenario.measure(base));
    heads.push(await scenario.measure(head));
    if (base && round % 2 === 1) bases.push(await scenario.measure(base));
  }
  const headMedian = median(heads);
  if (!base) {
    lines.push(`| ${scenario.name} | ${headMedian.toFixed(0)} |`);
    continue;
  }
  const baseMedian = median(bases);
  // Each round pairs the two builds minutes apart at most, so the median
  // of the per-round ratios cancels drift that a ratio of medians keeps.
  const change = median(heads.map((ns, round) => ns / bases[round]!)) - 1;
  const over = change > scenario.budget;
  failed ||= over;
  lines.push(
    `| ${scenario.name} | ${baseMedian.toFixed(0)} | ${headMedian.toFixed(0)} | ${(change * 100).toFixed(1)}%${over ? " over budget" : ""} | +${(scenario.budget * 100).toFixed(0)}% |`,
  );
}

process.stdout.write(`${lines.join("\n")}\n`);
process.exitCode = failed ? 1 : 0;
