/* eslint-disable no-console -- Executable review evidence. */
/**
 * Round-seven mutants: mechanisms none of the 27 round-six mutants touch.
 *
 * Same runner discipline as `validation/round-two/mutations.ts` (disposable
 * copy, the whole `test/round-two` suite, a kill needs a non-zero exit AND a
 * literal `(fail)`), with one difference: a survivor is REPORTED rather than
 * thrown, because the list of survivors is the finding.
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
const root = resolve(import.meta.dir, "../.."),
  dir = mkdtempSync(join(tmpdir(), "routecraft-round-seven-mutants-"));
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
/** [name, file, from, to, what a survivor means] */
const mutants: [string, string, string, string, string][] = [
  [
    "codec version ignored on resume",
    "runtime.ts",
    "saved.codec !== 1 ||",
    "false ||",
    "a continuation from a future codec is executed",
  ],
  [
    "unknown pending instruction accepted on resume",
    "runtime.ts",
    "saved.pending.some((x) => !route.steps.has(x))",
    "false",
    "a pending id the route no longer has passes the plan check",
  ],
  [
    "failed resume never settles the record",
    "runtime.ts",
    'await store.finish(id, "failed");',
    "void 0;",
    "a resumed run that throws leaves the claim held until the lease",
  ],
  [
    "duplicate deferral id accepted",
    "storage.ts",
    "[{ key: `record/${id}`, version: 0 }],",
    "[],",
    "a second save under one id overwrites the first continuation",
  ],
  [
    "retry attempts share one exchange object",
    "operations.ts",
    "exchange: structuredClone(run.exchange),",
    "exchange: run.exchange,",
    "an attempt's mutation leaks into the next attempt",
  ],
  [
    "observers receive the live event payload",
    "host.ts",
    "Object.freeze({ name, data: structuredClone(data) })",
    "Object.freeze({ name, data })",
    "an observer can mutate what the emitter and later observers see",
  ],
  [
    "branch identity check dropped",
    "runtime.ts",
    "known.execute !== s.execute",
    "false",
    "a branch may substitute a different function under a declared id",
  ],
  [
    "duplicate anchors accepted",
    "host.ts",
    "if (anchors.has(x.anchor.key))",
    "if (false)",
    "two contributions claim one anchor and the later one silently wins",
  ],
  [
    "runtime facet collision unchecked",
    "runtime.ts",
    'if (name in ex) throw new Fault("kernel", "FACET_COLLISION", name);',
    "",
    "a facet may shadow an exchange field at attach time",
  ],
  [
    "exit handlers never run",
    "runtime.ts",
    'for (const completed of result.exchanges) await this.handlers(route, "exit", completed, run.kind);',
    "",
    "the exit point is not load-bearing anywhere in the suite",
  ],
  [
    "dispatch inherits the caller's run kind",
    "runtime.ts",
    'kind: "normal", pending: target.initial,',
    "kind: run.kind, pending: target.initial,",
    "a hop from a resumed run applies the target's resume survival policy",
  ],
  [
    "late disposer accepted",
    "host.ts",
    'if (this.#phase === "stopped" || this.#phase === "stopping") throw new Fault(plugin.id, "LIFECYCLE", "late disposer");',
    "",
    "a disposer registered during teardown is silently dropped",
  ],
  [
    "route compilation after start accepted",
    "runtime.ts",
    'if (this.#accept) throw new Fault(spec.owner, "FROZEN", "route compilation");',
    "",
    "routes may be compiled against a chain that already froze",
  ],
  [
    "disabled route still delivers",
    "runtime.ts",
    'if (route.status.state === "disabled")',
    "if (false)",
    "disabling a route does not stop delivery",
  ],
  [
    "selected but unprovided port accepted",
    "host.ts",
    'for (const [key, p] of this.selected) if (!this.#values.has(key)) throw new Fault(p.plugin.id, "UNPROVIDED_PORT", p.port.name);',
    "",
    "a provider that declares a port and never provides it boots",
  ],
  [
    "step context require ignores declaration",
    "runtime.ts",
    "require: (contract) => this.host.requireFor(step.owner, contract),",
    "require: (contract) => this.host.service(contract),",
    "a step reads a service its plugin never declared",
  ],
];
const killed: string[] = [],
  survived: string[] = [];
try {
  for (const path of ["src/v2", "test/round-two"]) {
    mkdirSync(join(dir, path), { recursive: true });
    cpSync(join(root, path), join(dir, path), { recursive: true });
  }
  mkdirSync(join(dir, "validation/round-two"), { recursive: true });
  for (const f of [
    "process.ts",
    "packed.ts",
    "external.fixture.ts",
    "tsconfig.publish.json",
  ])
    cpSync(
      join(root, "validation/round-two", f),
      join(dir, "validation/round-two", f),
    );
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  for (const [name, file, from, to, meaning] of mutants) {
    const target = join(dir, "src/v2", file),
      original = readFileSync(target, "utf8");
    if (!pattern(from).test(original))
      throw Error(`mutation does not apply: ${name}`);
    writeFileSync(target, original.replace(pattern(from), to));
    const proc = spawn(
      [
        process.execPath,
        "test",
        // The packed test builds against the repository's node_modules, which
        // the disposable copy does not have, so it fails for every mutant and
        // would count as a kill. Round two's name filters exclude it too.
        "test/round-two/contracts.test.ts",
        "test/round-two/process.test.ts",
        "test/round-two/round-six.test.ts",
        "--timeout",
        "20000",
      ],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(() => proc.kill("SIGKILL"), 60000);
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    clearTimeout(timer);
    writeFileSync(target, original);
    const out = `${stdout}${stderr}`;
    const failing = [...out.matchAll(/\(fail\) (.+)/g)].map((m) => m[1]);
    if (code !== 0 && failing.length) {
      killed.push(name);
      console.log(`KILLED    ${name}  <- ${failing[0]}`);
    } else {
      survived.push(name);
      console.log(`SURVIVED  ${name}  :: ${meaning}`);
    }
  }
  console.log(
    `\n${killed.length} killed, ${survived.length} survived of ${mutants.length} round-seven mutants (contracts, process and round-six suites per mutant; packed excluded)`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
