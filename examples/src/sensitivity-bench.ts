/**
 * Benchmark a System One screen on our own labelled data: does this text
 * carry sensitive information?
 *
 * `classify-sensitivity` is the capability under test. It sends one text to
 * a decision model as a single noul question and returns the probability,
 * with the time the model call took. `backend` picks the model per call:
 *
 * - `jev`: TypeSafe AI's Jev, through TypeSafe directly when
 *   `TYPESAFE_API_KEY` is set, otherwise through OpenRouter's
 *   TypeSafe-compatible endpoint with `OPENROUTER_API_KEY`.
 * - `laya`: Convai Innovations' open Laya, through a `laya-serve` at
 *   `LAYA_URL` (default `http://localhost:8000`). `LAYA_CHECKPOINT` picks the
 *   checkpoint; the default lets the server route by language.
 *
 * Run as a script, it sends every item in `data/sensitivity-items.json` to
 * each backend `BENCH_RUNS` times (default 3), prints one comparison table,
 * what each backend got wrong, and a per-item matrix, and writes every answer
 * to `results/` so runs can be compared later:
 *
 *   bun examples/src/sensitivity-bench.ts
 *
 * `BENCH_BACKENDS` narrows the comparison (default `jev,laya`); a backend
 * without its key or server is reported and skipped.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ContextBuilder, craft, direct } from "@routecraft/routecraft";
import { noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { z } from "zod";

const SENSITIVE = noul(
  "Does this text contain sensitive information: credentials or secrets, personal identifiers, payment details, health, salary or HR matters about a specific person, or confidential business plans?",
);

const backend = z.enum(["jev", "laya"]);

type Backend = z.infer<typeof backend>;

export const classifyRequest = z.object({ text: z.string(), backend });

export type Classification = { sensitive: number; ms: number; model: string };

const openRouterKey = (): string => {
  const key = process.env["OPENROUTER_API_KEY"];
  if (!key) {
    throw new Error(
      "The jev backend needs TYPESAFE_API_KEY or OPENROUTER_API_KEY",
    );
  }
  return key;
};

const clients = new Map<Backend, TypeSafeClient>();

/**
 * Built on first use per backend: the client throws at construction without
 * a key, and a missing key for one backend must not stop the other.
 */
const clientFor = (b: Backend): TypeSafeClient => {
  const existing = clients.get(b);
  if (existing) return existing;
  const retry = { maxRetries: 0 };
  const created =
    b === "laya"
      ? new TypeSafeClient({
          baseURL: process.env["LAYA_URL"] ?? "http://localhost:8000",
          // laya-serve checks no key unless LAYA_API_KEY is set, but the
          // client refuses to construct without one.
          apiKey: process.env["LAYA_API_KEY"] ?? "laya-local",
          defaultModel: process.env["LAYA_CHECKPOINT"] ?? "jev-latest",
          retry,
          timeout: 30_000,
        })
      : process.env["TYPESAFE_API_KEY"]
        ? new TypeSafeClient({ retry })
        : new TypeSafeClient({
            baseURL: "https://openrouter.ai/api",
            apiKey: openRouterKey(),
            defaultModel: "jev-1.13",
            retry,
          });
  clients.set(b, created);
  return created;
};

export const classifySensitivity = craft()
  .id("classify-sensitivity")
  .input({ body: classifyRequest })
  .from(direct())
  .transform(async ({ text, backend: b }): Promise<Classification> => {
    const started = performance.now();
    const { answers, model } = await clientFor(b).systemOne({
      state: text,
      questions: { sensitive: SENSITIVE },
    });
    return {
      sensitive: answers.sensitive.noul,
      ms: performance.now() - started,
      model,
    };
  });

type Item = { id: string; sensitive: boolean; text: string };

type Answer = {
  run: number;
  backend: Backend;
  id: string;
  label: boolean;
  p: number | null;
  ms: number | null;
  model: string | null;
  error: string | null;
};

type Ok = Answer & { p: number; ms: number };

const out = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};

const percentile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? Number.NaN;
};

const mean = (xs: number[]): number =>
  xs.reduce((a, b) => a + b, 0) / xs.length;

const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;

type Summary = {
  backend: Backend;
  model: string;
  answers: number;
  errors: number;
  accuracy: number;
  precision: number;
  recall: number;
  brier: number;
  p50: number;
  p95: number;
  spread: number;
  /** Mean probability per item across runs. */
  means: Map<string, number>;
};

const summarise = (b: Backend, answers: Answer[]): Summary | null => {
  const ok = answers.filter((a): a is Ok => a.p !== null);
  if (ok.length === 0) return null;
  const tp = ok.filter((a) => a.label && a.p >= 0.5).length;
  const fp = ok.filter((a) => !a.label && a.p >= 0.5).length;
  const fn = ok.filter((a) => a.label && a.p < 0.5).length;
  const grouped = new Map<string, number[]>();
  for (const a of ok) grouped.set(a.id, [...(grouped.get(a.id) ?? []), a.p]);
  const ms = ok.map((a) => a.ms);
  return {
    backend: b,
    model: ok[0]!.model ?? "unknown",
    answers: ok.length,
    errors: answers.length - ok.length,
    accuracy: ok.filter((a) => a.p >= 0.5 === a.label).length / ok.length,
    precision: tp / (tp + fp) || 0,
    recall: tp / (tp + fn) || 0,
    brier: mean(ok.map((a) => (a.p - (a.label ? 1 : 0)) ** 2)),
    p50: percentile(ms, 0.5),
    p95: percentile(ms, 0.95),
    spread: Math.max(
      ...[...grouped.values()].map((ps) => Math.max(...ps) - Math.min(...ps)),
    ),
    means: new Map([...grouped].map(([id, ps]) => [id, mean(ps)])),
  };
};

const report = (
  items: Item[],
  runs: number,
  summaries: Summary[],
  skipped: string[],
): void => {
  const sensitive = items.filter((i) => i.sensitive).length;
  out(`# Sensitivity screen\n`);
  out(
    `${items.length} items (${sensitive} sensitive, ${items.length - sensitive} not), ${runs} run(s) each, ${summaries.length} backend(s).${skipped.length ? ` Skipped: ${skipped.join("; ")}.` : ""}\n`,
  );

  out(
    "| backend | model | accuracy | precision | recall | Brier | p50 | p95 | run-to-run |",
  );
  out("|---|---|---|---|---|---|---|---|---|");
  for (const s of summaries) {
    out(
      `| ${s.backend} | ${s.model} | ${pct(s.accuracy)} | ${s.precision.toFixed(2)} | ${s.recall.toFixed(2)} | ${s.brier.toFixed(3)} | ${s.p50.toFixed(0)} ms | ${s.p95.toFixed(0)} ms | ±${s.spread.toFixed(2)} |`,
    );
  }
  out();
  out(
    "Accuracy: answers on the right side of 0.5. Precision: of the items flagged sensitive, how many were. Recall: of the sensitive items, how many were flagged. Brier: mean squared distance of the probability from the truth, 0 is perfect and 0.25 is a coin flip. Run-to-run: the largest change in one item's probability between runs.",
  );

  for (const s of summaries) {
    const wrong = items.filter(
      (i) => (s.means.get(i.id) ?? 0) >= 0.5 !== i.sensitive,
    );
    const missed = wrong.filter((i) => i.sensitive);
    const flagged = wrong.filter((i) => !i.sensitive);
    out(`\n## ${s.backend}\n`);
    if (s.errors) out(`${s.errors} of ${s.answers + s.errors} calls failed.`);
    if (wrong.length === 0) {
      out("Right on every item.");
      continue;
    }
    if (missed.length) {
      out(`Missed ${missed.length} of ${sensitive} sensitive items:`);
      for (const i of missed) {
        out(`- ${i.id} (${s.means.get(i.id)!.toFixed(2)}): ${i.text}`);
      }
    }
    if (flagged.length) {
      if (missed.length) out();
      out(`Flagged ${flagged.length} item(s) that are not sensitive:`);
      for (const i of flagged) {
        out(`- ${i.id} (${s.means.get(i.id)!.toFixed(2)}): ${i.text}`);
      }
    }
  }

  out(`\n## Per item\n`);
  out(
    "Mean p(sensitive) per backend; ✗ marks an answer on the wrong side of 0.5.\n",
  );
  out(`| item | label | ${summaries.map((s) => s.backend).join(" | ")} |`);
  out(`|---|---|${summaries.map(() => "---").join("|")}|`);
  for (const i of items) {
    const cells = summaries.map((s) => {
      const p = s.means.get(i.id);
      if (p === undefined) return "n/a";
      return `${p.toFixed(2)}${p >= 0.5 !== i.sensitive ? " ✗" : ""}`;
    });
    out(
      `| ${i.id} | ${i.sensitive ? "sensitive" : "not"} | ${cells.join(" | ")} |`,
    );
  }
};

const main = async (): Promise<void> => {
  const items: Item[] = JSON.parse(
    readFileSync(
      new URL("../data/sensitivity-items.json", import.meta.url),
      "utf8",
    ),
  );
  const runs = Number(process.env["BENCH_RUNS"] ?? 3);
  const noJevKey =
    !process.env["TYPESAFE_API_KEY"] && !process.env["OPENROUTER_API_KEY"];
  const skipped: string[] = [];
  const backends = (process.env["BENCH_BACKENDS"] ?? "jev,laya")
    .split(",")
    .map((b) => backend.parse(b.trim()))
    .filter((b) => {
      if (b === "jev" && noJevKey) {
        skipped.push("jev (set TYPESAFE_API_KEY or OPENROUTER_API_KEY)");
        return false;
      }
      return true;
    });

  const builder = new ContextBuilder();
  builder.routes(classifySensitivity);
  const { context, client } = await builder.build();
  const started = context.start();

  const answers: Answer[] = [];
  try {
    for (let run = 1; run <= runs; run++) {
      for (const b of backends) {
        for (const item of items) {
          try {
            const r = (await client.sendDirect("classify-sensitivity", {
              text: item.text,
              backend: b,
            })) as Classification;
            answers.push({
              run,
              backend: b,
              id: item.id,
              label: item.sensitive,
              p: r.sensitive,
              ms: r.ms,
              model: r.model,
              error: null,
            });
          } catch (error) {
            answers.push({
              run,
              backend: b,
              id: item.id,
              label: item.sensitive,
              p: null,
              ms: null,
              model: null,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }
  } finally {
    await context.stop();
    await started.catch(() => undefined);
  }

  const summaries: Summary[] = [];
  for (const b of backends) {
    const s = summarise(
      b,
      answers.filter((a) => a.backend === b),
    );
    if (s) summaries.push(s);
    else {
      const first = answers.find((a) => a.backend === b)?.error;
      skipped.push(`${b} (no answers${first ? `: ${first}` : ""})`);
    }
  }
  report(items, runs, summaries, skipped);

  const dir = new URL("../results/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  const file = new URL(
    `sensitivity-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    dir,
  );
  writeFileSync(file, JSON.stringify({ runs, backends, answers }, null, 2));
  out(`\nEvery answer: ${file.pathname}`);
};

if (import.meta.main) await main();
