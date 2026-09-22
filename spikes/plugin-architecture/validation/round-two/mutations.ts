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
  const survivors: string[] = [];
  for (const [name, file, from, to, filter] of mutants) {
    const target = join(dir, "src/v2", file),
      original = readFileSync(target, "utf8");
    if (!pattern(from).test(original))
      throw Error(`mutation no longer applies: ${name}`);
    writeFileSync(target, original.replace(pattern(from), to));
    const proc = spawn(
      [
        process.execPath,
        "test",
        "test/round-two",
        "--test-name-pattern",
        filter,
      ],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(() => proc.kill("SIGKILL"), 8000);
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    clearTimeout(timer);
    writeFileSync(target, original);
    if (code === 0 || !`${stdout}${stderr}`.includes("(fail)")) {
      survivors.push(name);
      console.log(
        `SURVIVED or invalid mutation: ${name}\n${stdout}\n${stderr}`,
      );
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
