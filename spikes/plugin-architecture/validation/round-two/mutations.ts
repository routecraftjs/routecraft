import { spawn } from "bun";
/* eslint-disable no-console -- Executable spike reports intentionally write validation evidence. */
/** Mutations run in a disposable copy, never editing the reviewed implementation. */
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
const root = resolve(import.meta.dir, "../.."),
  dir = mkdtempSync(join(tmpdir(), "routecraft-mutations-"));
/** One run of the copied suite, filtered or whole. `ran` is whether at least one test executed. */
async function runSuite(filter?: string) {
  const proc = spawn(
    [
      process.execPath,
      "test",
      "test/round-two",
      ...(filter ? ["--test-name-pattern", filter] : []),
    ],
    { cwd: dir, stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => proc.kill("SIGKILL"), filter ? 8000 : 90000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(timer);
  const output = `${stdout}${stderr}`;
  // A test ran when a per-test marker was printed (a hung run prints no summary) or the summary counts a pass (a file that failed to load counts none).
  const passed = Number(/(\d+) pass/.exec(output)?.[1] ?? 0);
  return { code, ran: /\((pass|fail)\)/.test(output) || passed > 0, output };
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
import { mutants } from "./mutants.ts";

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
  // The unchanged copy must pass the whole suite first, or a kill could be the copy's own failure.
  // The packed consumer is excluded by name: it builds from files the copy deliberately lacks.
  const baseline = await runSuite("^(?!independently compiled plugin)");
  if (baseline.code !== 0 || !baseline.ran)
    throw Error(`unchanged copy does not pass: ${baseline.output}`);
  console.log("CONTROL: unchanged copy passes the whole suite");
  const survivors: string[] = [];
  for (const [name, file, from, to, filter] of mutants) {
    const target = join(dir, "src/v2", file),
      original = readFileSync(target, "utf8");
    const matches = original.match(new RegExp(pattern(from).source, "g")) ?? [];
    if (matches.length === 0)
      throw Error(`mutation no longer applies: ${name}`);
    // A pattern that matches twice is at the right site by file order only; assert the count.
    if (matches.length > 1)
      throw Error(
        `mutation pattern is ambiguous (${matches.length} sites): ${name}`,
      );
    writeFileSync(target, original.replace(pattern(from), to));
    const { code, ran, output } = await runSuite(filter);
    writeFileSync(target, original);
    // A kill is a test that RAN and failed: a file that failed to load has a marker but no test.
    if (code === 0 || !ran || !output.includes("(fail)")) {
      survivors.push(name);
      console.log(`SURVIVED or invalid mutation: ${name}\n${output}`);
      continue;
    }
    console.log(`KILLED: ${name}`);
  }
  if (survivors.length)
    throw Error(
      `${survivors.length} mutants survived: ${survivors.join("; ")}`,
    );
  console.log(
    `${mutants.length}/${mutants.length} runtime mutations killed by behavioral assertions`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
