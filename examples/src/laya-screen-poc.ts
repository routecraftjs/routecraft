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

type Summary = {
  checkpoint: string;
  correct: number;
  brier: number;
  p50: number;
  worstFail: number;
  safePasses: number;
  /** Per threshold: the cases passed, and the failures among them. */
  atThreshold: { t: number; passed: Scored[]; wrong: Scored[] }[];
  byCase: Map<string, number>;
};

const summarise = (checkpoint: string, scored: Scored[]): Summary => {
  const worstFail = Math.max(...scored.filter((s) => !s.met).map((s) => s.p));
  return {
    checkpoint,
    correct: scored.filter((s) => s.p >= 0.5 === s.met).length,
    brier:
      scored.reduce((sum, s) => sum + (s.p - (s.met ? 1 : 0)) ** 2, 0) /
      scored.length,
    p50: median(scored.map((s) => s.ms)),
    worstFail,
    safePasses: scored.filter((s) => s.met && s.p > worstFail).length,
    atThreshold: THRESHOLDS.map((t) => {
      const passed = scored.filter((s) => s.p >= t);
      return { t, passed, wrong: passed.filter((s) => !s.met) };
    }),
    byCase: new Map(scored.map((s) => [s.id, s.p])),
  };
};

const report = (summaries: Summary[]): void => {
  const met = cases.filter((c) => c.met).length;
  out(`# Laya as the judge screen\n`);
  out(
    `${cases.length} labelled cases (${met} met, ${cases.length - met} not met), server ${baseURL}.\n`,
  );

  const thresholdHeads = THRESHOLDS.map((t) => `passes at ${t} (wrong)`);
  out(
    `| checkpoint | accuracy | Brier | p50 | safe passes | ${thresholdHeads.join(" | ")} |`,
  );
  out(`|---|---|---|---|---|${THRESHOLDS.map(() => "---").join("|")}|`);
  for (const s of summaries) {
    const cells = s.atThreshold.map(
      (a) => `${a.passed.length} (${a.wrong.length})`,
    );
    out(
      `| ${s.checkpoint} | ${s.correct}/${cases.length} | ${s.brier.toFixed(3)} | ${s.p50.toFixed(0)} ms | ${s.safePasses} of ${met} | ${cells.join(" | ")} |`,
    );
  }
  out();
  out(
    "Accuracy: cases on the right side of 0.5. Brier: mean squared distance of p(met) from the truth, 0 is perfect and 0.25 is a coin flip. Safe passes: met cases scoring above the highest-scored failure, the most any threshold could skip the reasoning judge on without letting a failure through. Passes at a threshold: cases the route would pass without the reasoning judge, and how many of those were failures.",
  );

  for (const s of summaries) {
    out(`\n## ${s.checkpoint}\n`);
    out(
      `Highest-scored failure ${s.worstFail.toFixed(2)}, so a threshold above it passes ${s.safePasses} of ${met} met cases with no wrong pass.`,
    );
    const wrong = s.atThreshold.filter((a) => a.wrong.length);
    if (wrong.length === 0) {
      out("No wrong passes at any threshold.");
      continue;
    }
    out("Wrong passes:");
    for (const a of wrong) {
      out(
        `- at ${a.t}: ${a.wrong.map((w) => `${w.id} (${w.p.toFixed(2)})`).join(", ")}`,
      );
    }
  }

  out(`\n## Per case\n`);
  out("p(met) per checkpoint; ✗ marks an answer on the wrong side of 0.5.\n");
  out(`| case | label | ${summaries.map((s) => s.checkpoint).join(" | ")} |`);
  out(`|---|---|${summaries.map(() => "---").join("|")}|`);
  for (const c of cases) {
    const cells = summaries.map((s) => {
      const p = s.byCase.get(c.id)!;
      return `${p.toFixed(2)}${p >= 0.5 !== c.met ? " ✗" : ""}`;
    });
    out(`| ${c.id} | ${c.met ? "met" : "not met"} | ${cells.join(" | ")} |`);
  }
};

const summaries: Summary[] = [];
for (const checkpoint of checkpoints) {
  summaries.push(summarise(checkpoint, await run(checkpoint)));
}
report(summaries);
