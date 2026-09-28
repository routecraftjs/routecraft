/**
 * Proof of concept: the Jev screen from `jev-judge.ts`, answered by Laya.
 *
 * Laya (Convai Innovations, Apache 2.0) ships `laya-serve`, which speaks
 * Jev's `POST /v1/systemone` protocol. So the screen runs unchanged: this
 * script builds a TypeSafe client pointed at a local `laya-serve`, sends each
 * labelled case in `data/judge-cases.json` through the same `screen()` the
 * judge route calls, and reports what each checkpoint would have done at the
 * route's thresholds.
 *
 * The cases are synthetic and few. They check that the wiring works and show
 * how each checkpoint leans; they are not a benchmark.
 *
 * Run `laya-serve` first (`pip install "laya[serve]"`), then:
 *
 *   bun examples/src/laya-screen-poc.ts
 *
 * `LAYA_URL` overrides the server (default `http://localhost:8000`), and
 * `LAYA_CHECKPOINTS` the comma-separated checkpoints to compare (default
 * `english,multilingual,typed-decisions`).
 */
// The screen reads none of the keys src/env.ts validates on import; these fill them.
import "../test/env-placeholders.ts";
import { readFileSync } from "node:fs";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { screen, type JudgeEvidence } from "./jev-judge.ts";

type Case = { id: string; met: boolean; evidence: JudgeEvidence };

type Scored = Case & { p: number; ms: number };

const THRESHOLDS = [0.85, 0.9];

const cases: Case[] = JSON.parse(
  readFileSync(new URL("../data/judge-cases.json", import.meta.url), "utf8"),
);

const baseURL = process.env["LAYA_URL"] ?? "http://localhost:8000";
const checkpoints = (
  process.env["LAYA_CHECKPOINTS"] ?? "english,multilingual,typed-decisions"
)
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);

const out = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const run = async (checkpoint: string): Promise<Scored[]> => {
  const client = new TypeSafeClient({
    baseURL,
    // laya-serve checks no key unless LAYA_API_KEY is set, but the client
    // refuses to construct without one.
    apiKey: process.env["LAYA_API_KEY"] ?? "laya-local",
    defaultModel: checkpoint,
    retry: { maxRetries: 0 },
    timeout: 30_000,
  });
  // One unscored call first, so a lazily loaded checkpoint does not bill its
  // load time to the first case.
  await screen(cases[0]!.evidence, client);
  const scored: Scored[] = [];
  for (const c of cases) {
    const started = performance.now();
    const { met } = await screen(c.evidence, client);
    scored.push({ ...c, p: met, ms: performance.now() - started });
  }
  return scored;
};

const report = (checkpoint: string, scored: Scored[]): void => {
  const brier =
    scored.reduce((sum, s) => sum + (s.p - (s.met ? 1 : 0)) ** 2, 0) /
    scored.length;
  const correctAtHalf = scored.filter((s) => s.p >= 0.5 === s.met).length;

  out(`\n## ${checkpoint}\n`);
  out("| case | label | p(met) | ms |");
  out("|---|---|---|---|");
  for (const s of scored) {
    out(
      `| ${s.id} | ${s.met ? "met" : "not met"} | ${s.p.toFixed(3)} | ${s.ms.toFixed(0)} |`,
    );
  }
  out(
    `\nAccuracy at 0.5: ${correctAtHalf}/${scored.length}. Brier: ${brier.toFixed(3)}. Median latency: ${median(scored.map((s) => s.ms)).toFixed(0)} ms.`,
  );
  const worstFail = Math.max(...scored.filter((s) => !s.met).map((s) => s.p));
  const safePasses = scored.filter((s) => s.met && s.p > worstFail).length;
  out(
    `Highest-scored failure: ${worstFail.toFixed(3)}. A threshold above it passes ${safePasses} of ${scored.filter((s) => s.met).length} met cases with no wrong pass.`,
  );
  for (const t of THRESHOLDS) {
    const passed = scored.filter((s) => s.p >= t);
    const wrong = passed.filter((s) => !s.met);
    out(
      `passAt ${t}: ${passed.length} passed without the reasoning judge, ${wrong.length} of them wrongly${wrong.length ? ` (${wrong.map((w) => w.id).join(", ")})` : ""}; ${scored.length - passed.length} escalated.`,
    );
  }
};

out(
  `# Laya as the judge screen\n\n${cases.length} labelled cases (${cases.filter((c) => c.met).length} met), server ${baseURL}.`,
);
for (const checkpoint of checkpoints) {
  report(checkpoint, await run(checkpoint));
}
