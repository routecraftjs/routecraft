/* eslint-disable no-console -- Executable review evidence. */
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, Transpiler } from "bun";
const root = resolve(import.meta.dir, "../..");
const temp = mkdtempSync(join(tmpdir(), "contract-review-"));
const copy = join(temp, "repo/spikes/plugin-architecture");
mkdirSync(copy, { recursive: true });
for (const dir of ["src", "test/round-two", "validation/round-two"])
  cpSync(join(root, dir), join(copy, dir), { recursive: true });
cpSync(join(root, "tsconfig.json"), join(copy, "tsconfig.json"));
symlinkSync(
  resolve(root, "../../node_modules"),
  join(temp, "repo/node_modules"),
  "dir",
);
writeFileSync(join(copy, "package.json"), '{"type":"module"}');
const parser = new Transpiler({ loader: "ts", target: "bun" });
async function run() {
  const p = spawn(
    [process.execPath, "test", "test/round-two", "--timeout", "20000"],
    { cwd: copy, stdout: "pipe", stderr: "pipe" },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    p.kill();
  }, 60000);
  const [code, out, err] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  clearTimeout(timer);
  const output = out + err;
  const passed = Number(output.match(/\b(\d+) pass\b/)?.[1] ?? 0);
  const failed = Number(output.match(/\b(\d+) fail\b/)?.[1] ?? 0);
  const errors = Number(output.match(/\b(\d+) errors?\b/)?.[1] ?? 0);
  const names = [...output.matchAll(/\(fail\) ([^\n]+)/g)].map((m) => m[1]);
  const assertion = /expect\(received\)|Expected:|AssertionError/.test(output);
  const status =
    timedOut || errors || passed + failed !== 56
      ? "INVALID"
      : code === 0 && passed === 56
        ? "SURVIVED"
        : failed > 0 && names.length && assertion
          ? "KILLED"
          : "INVALID";
  return { status, passed, failed, names, output };
}
function replace(text: string, from: string, to: string) {
  if (text.split(from).length !== 2)
    throw Error("mutation must match exactly once: " + from);
  return text.replace(from, to);
}
const mutants: [string, string, string, string][] = [
  [
    "nested child definitions omitted from tail hash",
    "runtime.ts",
    "step.children?.map(describe) ?? [],",
    "[],",
  ],
  [
    "auth grant array no longer frozen",
    "auth.ts",
    "grants: Object.freeze([...principal.grants]),",
    "grants: [...principal.grants],",
  ],
  [
    "expiry scan ignores deadline",
    "storage.ts",
    'typeof at === "number" && at <= now',
    'typeof at === "number"',
  ],
  [
    "markExpired accepts unclaimed waiting records",
    "storage.ts",
    '!row || saved.state !== "waiting" || saved.claimedAt === undefined',
    '!row || saved.state !== "waiting"',
  ],
  [
    "duplicate drops cached exchanges",
    "runtime.ts",
    "record.outcome?.exchanges.map((x: SerializedExchange) =>\n            wireExchange(x),\n          ) ?? []",
    "[]",
  ],
  [
    "stored headers override resume ingress",
    "runtime.ts",
    "headers: { ...saved.exchange.headers, ...headers },",
    "headers: { ...headers, ...saved.exchange.headers },",
  ],
  [
    "authority effective grants empty",
    "auth.ts",
    "return p?.authentic ? [...p.grants, ...p.lent] : [];",
    "return [];",
  ],
];
try {
  const baseline = await run();
  if (baseline.status !== "SURVIVED")
    throw Error("baseline invalid\n" + baseline.output);
  console.log(
    "BASELINE: 56 pass, 0 fail in disposable copy including packed consumer",
  );
  const file = join(copy, "src/v2/auth.ts"),
    original = readFileSync(file, "utf8");
  parser.transformSync(original + "\n// inert control\n");
  writeFileSync(file, original + "\n// inert control\n");
  const noop = await run();
  if (noop.status !== "SURVIVED") throw Error("no-op failed\n" + noop.output);
  console.log("CONTROL no-op: SURVIVED");
  let syntaxRejected = false;
  try {
    parser.transformSync(original + "\n@@@ (((\n");
  } catch {
    syntaxRejected = true;
  }
  if (!syntaxRejected) throw Error("parser did not reject invalid control");
  console.log("CONTROL syntax error: INVALID before tests");
  writeFileSync(file, original + '\nimport "./missing-review-module.ts";\n');
  const missing = await run();
  if (missing.status !== "INVALID")
    throw Error("missing import misclassified\n" + missing.output);
  console.log("CONTROL missing import: INVALID");
  writeFileSync(
    file,
    replace(
      original,
      'if (!p) return { kind: "refuse", reason: "no principal" };',
      'if (!p) return { kind: "refuse", reason: "no principal" }; throw new Error("review control");',
    ),
  );
  const positive = await run();
  if (positive.status !== "KILLED")
    throw Error("positive control not killed\n" + positive.output);
  console.log("CONTROL behavioral assertion: KILLED");
  writeFileSync(file, original);
  let killed = 0,
    survived = 0;
  for (const [name, file, from, to] of mutants) {
    const target = join(copy, "src/v2", file),
      source = readFileSync(target, "utf8");
    const changed = replace(source, from, to);
    parser.transformSync(changed);
    writeFileSync(target, changed);
    const result = await run();
    writeFileSync(target, source);
    if (result.status === "INVALID")
      throw Error(name + " INVALID\n" + result.output);
    if (result.status === "KILLED") killed++;
    else survived++;
    console.log(
      `${result.status}: ${name}; ${result.passed} pass, ${result.failed} fail${result.names.length ? "; " + result.names.join("; ") : ""}`,
    );
  }
  console.log(
    `RESULT: ${killed} killed, ${survived} survived, ${mutants.length} new mutants; full baseline acceptance suite per mutant`,
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
