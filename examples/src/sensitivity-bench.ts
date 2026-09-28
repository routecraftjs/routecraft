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
 * each backend `BENCH_RUNS` times (default 3), prints accuracy, calibration,
 * latency and run-to-run stability per backend, and writes every answer to
 * `results/` so runs can be compared later:
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

const out = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};

const percentile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? Number.NaN;
};

const summarise = (b: Backend, answers: Answer[]): void => {
  const ok = answers.filter(
    (a): a is Answer & { p: number; ms: number } => a.p !== null,
  );
  out(`\n## ${b}${ok[0]?.model ? ` (${ok[0].model})` : ""}\n`);
  if (ok.length === 0) {
    out(`No answers. First error: ${answers[0]?.error ?? "none recorded"}`);
    return;
  }
  const tp = ok.filter((a) => a.label && a.p >= 0.5).length;
  const fp = ok.filter((a) => !a.label && a.p >= 0.5).length;
  const fn = ok.filter((a) => a.label && a.p < 0.5).length;
  const correct = ok.filter((a) => a.p >= 0.5 === a.label).length;
  const brier =
    ok.reduce((sum, a) => sum + (a.p - (a.label ? 1 : 0)) ** 2, 0) / ok.length;
  const byItem = new Map<string, number[]>();
  for (const a of ok) byItem.set(a.id, [...(byItem.get(a.id) ?? []), a.p]);
  const spread = Math.max(
    ...[...byItem.values()].map((ps) => Math.max(...ps) - Math.min(...ps)),
  );
  const ms = ok.map((a) => a.ms);

  out(
    `Answers: ${ok.length}, errors: ${answers.length - ok.length}. Accuracy at 0.5: ${((correct / ok.length) * 100).toFixed(1)}%. Precision: ${(tp / (tp + fp) || 0).toFixed(2)}. Recall: ${(tp / (tp + fn) || 0).toFixed(2)}. Brier: ${brier.toFixed(3)}.`,
  );
  out(
    `Latency p50 ${percentile(ms, 0.5).toFixed(0)} ms, p95 ${percentile(ms, 0.95).toFixed(0)} ms. Largest run-to-run spread on one item: ${spread.toFixed(3)}.`,
  );
  const wrong = [...byItem.entries()]
    .map(([id, ps]) => {
      const label = ok.find((a) => a.id === id)!.label;
      const mean = ps.reduce((x, y) => x + y, 0) / ps.length;
      return { id, label, mean };
    })
    .filter((w) => w.mean >= 0.5 !== w.label);
  if (wrong.length) {
    out(`\nWrong on average (mean p(sensitive)):`);
    for (const w of wrong) {
      out(
        `- ${w.id}: labelled ${w.label ? "sensitive" : "not sensitive"}, ${w.mean.toFixed(3)}`,
      );
    }
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
  const backends = (process.env["BENCH_BACKENDS"] ?? "jev,laya")
    .split(",")
    .map((b) => backend.parse(b.trim()))
    .filter((b) => {
      if (b === "jev" && noJevKey) {
        out("Skipping jev: set TYPESAFE_API_KEY or OPENROUTER_API_KEY.");
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

  out(
    `# Sensitivity screen: ${items.length} items (${items.filter((i) => i.sensitive).length} sensitive), ${runs} run(s)`,
  );
  for (const b of backends) {
    summarise(
      b,
      answers.filter((a) => a.backend === b),
    );
  }

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
