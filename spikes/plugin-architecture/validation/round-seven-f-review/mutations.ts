import { spawn } from "bun";
/* eslint-disable no-console -- Executable review evidence. */
/**
 * Review mutation runner. Same discipline as `validation/round-two/mutations.ts`
 * (its tokenizing `pattern` is copied verbatim), with two differences: every
 * mutant runs against the WHOLE suite rather than one named test, and a run
 * is classified three ways (killed, survived, invalid) instead of two.
 */
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
import { mutants } from "./mutants.ts";

const root = resolve(import.meta.dir, "../.."),
  dir = mkdtempSync(join(tmpdir(), "rc-7f-review-mutations-"));
const EXCLUDE = "^(?!independently compiled plugin)";

async function runSuite() {
  const proc = spawn(
    [
      process.execPath,
      "test",
      "test/round-two",
      "--test-name-pattern",
      EXCLUDE,
    ],
    {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timer = setTimeout(() => proc.kill("SIGKILL"), 90000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(timer);
  const output = `${stdout}${stderr}`;
  const passed = Number(/(\d+) pass/.exec(output)?.[1] ?? 0);
  const failed = Number(/(\d+) fail/.exec(output)?.[1] ?? 0);
  return { code, passed, failed, output };
}
function pattern(text: string): RegExp {
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

try {
  for (const path of ["src/v2", "test/round-two"]) {
    mkdirSync(join(dir, path), { recursive: true });
    cpSync(join(root, path), join(dir, path), { recursive: true });
  }
  mkdirSync(join(dir, "validation/round-two"), { recursive: true });
  cpSync(
    join(root, "validation/round-two/process.ts"),
    join(dir, "validation/round-two/process.ts"),
  );
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  const baseline = await runSuite();
  if (baseline.code !== 0 || baseline.passed === 0 || baseline.failed !== 0)
    throw Error(`unchanged copy does not pass: ${baseline.output}`);
  console.log(
    `CONTROL: unchanged copy passes the whole suite (${baseline.passed} pass)`,
  );
  const tally = { killed: 0, survived: 0, invalid: 0 };
  for (const [name, file, from, to, meaning] of mutants) {
    const target = join(dir, "src/v2", file),
      original = readFileSync(target, "utf8");
    const count = (original.match(new RegExp(pattern(from).source, "g")) ?? [])
      .length;
    if (count !== 1) {
      console.log(`INVALID (pattern matched ${count} times): ${name}`);
      tally.invalid++;
      continue;
    }
    writeFileSync(target, original.replace(pattern(from), to));
    const run = await runSuite();
    writeFileSync(target, original);
    const failing = [...run.output.matchAll(/\(fail\) ([^\n[]+)/g)].map((m) =>
      m[1]!.trim(),
    );
    if (
      run.passed + run.failed === 0 ||
      (run.code !== 0 && failing.length === 0)
    ) {
      console.log(`INVALID (no test ran or no test failed): ${name}`);
      tally.invalid++;
    } else if (run.code === 0) {
      console.log(`SURVIVED: ${name} -- ${meaning}`);
      tally.survived++;
    } else {
      console.log(
        `KILLED: ${name} -- by ${failing.slice(0, 2).join(" | ")}${failing.length > 2 ? ` (+${failing.length - 2})` : ""}`,
      );
      tally.killed++;
    }
  }
  console.log(
    `${tally.killed} killed, ${tally.survived} survived, ${tally.invalid} invalid of ${mutants.length}`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
