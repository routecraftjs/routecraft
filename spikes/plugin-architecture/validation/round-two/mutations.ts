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
const mutants: [string, string, string, string, string][] = [
  [
    "duplicate provider accepted",
    "host.ts",
    "c.plugins.length > 1",
    "false",
    "replacement under own identity",
  ],
  [
    "installation order breaks ties",
    "graph.ts",
    "a.id < b.id ? -1 : a.id > b.id ? 1 : 0",
    "0",
    "four handlers use selectors",
  ],
  [
    "concurrency reset per delivery",
    "operations.ts",
    "const max = Number",
    "active=0; const max = Number",
    "concurrency and breaker state",
  ],
  [
    "breaker reset per delivery",
    "operations.ts",
    "if (failures >= limit)",
    "if ((failures=0) >= limit)",
    "concurrency and breaker state",
  ],
  [
    "changed plan accepted",
    "runtime.ts",
    "saved.plan !== route.hash",
    "false",
    "defer → SIGKILL",
  ],
  [
    "fanout drops second child",
    "runtime.ts",
    "for (const child of outcome.exchanges)",
    "for (const child of outcome.exchanges.slice(0,1))",
    "runPaths isolates failures",
  ],
  [
    "handler decoration discarded",
    "runtime.ts",
    "ex = this.attach(wireExchange(result.exchange));",
    "ex = ex;",
    "four handlers use selectors",
  ],

  [
    "resume repeats prefix",
    "runtime.ts",
    "pending:claimed.pending",
    "pending:route.initial",
    "defer → SIGKILL",
  ],
  [
    "defer fails to halt",
    "runtime.ts",
    "deferrals.push(outcome.request.id);pending=[]",
    "deferrals.push(outcome.request.id)",
    "defer → SIGKILL",
  ],
  [
    "reentrant instruction skipped",
    "runtime.ts",
    "outcome.request.reenter?[id,...pending]:pending",
    "pending",
    "defer → SIGKILL",
  ],
  [
    "CAS condition ignored",
    "storage.ts",
    "if((this.get(condition.key)?.version??0)!==condition.version)",
    "if(false)",
    "CAS under overlapping",
  ],
  [
    "transaction removed",
    "storage.ts",
    "this.db.exec('BEGIN IMMEDIATE')",
    "this.db.exec('SELECT 1')",
    "SIGKILL between record",
  ],
  [
    "delete is a read",
    "storage.ts",
    "DELETE FROM records WHERE key=?",
    "SELECT key FROM records WHERE key=?",
    "atomic store deletes",
  ],
  [
    "dependencies disposed first",
    "host.ts",
    "[...this.#applied].reverse()",
    "[...this.#applied]",
    "rollback and teardown",
  ],
  [
    "remaining cleanup skipped",
    "host.ts",
    "[...cleanup].reverse()",
    "[...cleanup].reverse().slice(0,1)",
    "rollback and teardown",
  ],
  [
    "observer failure escapes",
    "host.ts",
    "catch(e){this.faults.push(fault(observer.owner,'OBSERVER',e));}",
    "catch(e){throw e;}",
    "observers cannot abort",
  ],
  [
    "secondary error replaces primary",
    "runtime.ts",
    "error.secondary.push(failure);continue;",
    "throw failure;",
    "failing error handler",
  ],
  [
    "cancelled effect fence removed",
    "runtime.ts",
    "commit:(effect)=>{assertActive();return effect();}",
    "commit:(effect)=>effect()",
    "timeout cancels",
  ],
  [
    "resume admission skipped",
    "runtime.ts",
    "const admitted=await this.handlers(route,'admission',this.attach(wireExchange(saved.exchange)),'resume');",
    "const admitted=saved.exchange;",
    "resume rechecks admission",
  ],
  [
    "source never subscribed",
    "runtime.ts",
    "if(route.spec.source){",
    "if(false&&route.spec.source){",
    "source really emits",
  ],
  [
    "stream completion reported early",
    "runtime.ts",
    "const settled=await Promise.allSettled(streams);",
    "const settled=[];",
    "drain owns streaming",
  ],
  [
    "complete does not halt",
    "runtime.ts",
    "pending=[];ex=outcome.exchange;break;",
    "ex=outcome.exchange;break;",
    "continue, complete, drop",
  ],
];
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
    if (code === 0 || !`${stdout}${stderr}`.includes("(fail)"))
      throw Error(
        `SURVIVED or invalid mutation: ${name}\n${stdout}\n${stderr}`,
      );
    console.log(`KILLED: ${name}`);
  }
  console.log(
    `${mutants.length}/${mutants.length} runtime mutations killed by behavioral assertions`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
