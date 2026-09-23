/**
 * The mutation discipline of `validation/round-two/mutations.ts`, factored so
 * the review can run its own mutants and its own harness controls through
 * the same mechanics. Three verdicts instead of two: a run whose output
 * carries no per-test `(fail)` marker is INVALID, never a kill, whether it
 * exited non-zero, hung until the kill timer, or ran no test at all.
 */
import { spawn } from "bun";
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const spike = resolve(import.meta.dir, "../..");
export type Mutant = [
  name: string,
  file: string,
  from: string,
  to: string,
  filter: string,
];
export type Verdict = "killed" | "survived" | "invalid";

/** Verbatim copy of the round-two runner's pattern builder. */
export function pattern(text: string): RegExp {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tokens =
    text.match(/'[^']*'|"[^"]*"|[A-Za-z_$][\w$]*|[0-9]+|[^\s]/g) ?? [];
  return new RegExp(
    tokens
      .map((t) =>
        t.startsWith("'") || t.startsWith('"')
          ? "[\"']" + escape(t.slice(1, -1)) + "[\"']"
          : ([")", "]", "}"].includes(t) ? ",?\\s*" : "") + escape(t),
      )
      .join("\\s*"),
  );
}

/** How many places a mutant's pattern matches in its target: `String.replace` only ever edits the first. */
export function occurrences(file: string, from: string): number {
  const source = readFileSync(join(spike, "src/v2", file), "utf8");
  const global = new RegExp(pattern(from).source, "g");
  return [...source.matchAll(global)].length;
}

export function disposableCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "routecraft-7e-review-"));
  for (const path of ["src/v2", "test/round-two"]) {
    mkdirSync(join(dir, path), { recursive: true });
    cpSync(join(spike, path), join(dir, path), { recursive: true });
  }
  mkdirSync(join(dir, "validation/round-two"), { recursive: true });
  cpSync(
    join(spike, "validation/round-two/process.ts"),
    join(dir, "validation/round-two/process.ts"),
  );
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  return dir;
}

export async function runSuite(
  dir: string,
  filter: string,
  timeoutMs = 8000,
): Promise<{ code: number | null; output: string; killedByTimer: boolean }> {
  const proc = spawn(
    [process.execPath, "test", "test/round-two", "--test-name-pattern", filter],
    { cwd: dir, stdout: "pipe", stderr: "pipe" },
  );
  let killedByTimer = false;
  const timer = setTimeout(() => {
    killedByTimer = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(timer);
  return { code, output: `${stdout}${stderr}`, killedByTimer };
}

/** The names of the tests that printed a `(fail)` marker. */
export function failingTests(output: string): string[] {
  return [...output.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm)].map(
    (m) => m[1]!,
  );
}

export function verdictOf(code: number | null, output: string): Verdict {
  if (code === 0) return "survived";
  return output.includes("(fail)") ? "killed" : "invalid";
}

/** Apply one mutant in the copy, run the filtered suite, restore the file. Throws when the pattern no longer matches. */
export async function runMutant(
  dir: string,
  [name, file, from, to, filter]: Mutant,
  timeoutMs = 8000,
): Promise<{
  verdict: Verdict;
  output: string;
  killedByTimer: boolean;
  failures: string[];
}> {
  const target = join(dir, "src/v2", file),
    original = readFileSync(target, "utf8");
  if (!pattern(from).test(original))
    throw Error(`mutation no longer applies: ${name}`);
  writeFileSync(target, original.replace(pattern(from), to));
  try {
    const { code, output, killedByTimer } = await runSuite(
      dir,
      filter,
      timeoutMs,
    );
    return {
      verdict: verdictOf(code, output),
      output,
      killedByTimer,
      failures: failingTests(output),
    };
  } finally {
    writeFileSync(target, original);
  }
}

export function dispose(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}
