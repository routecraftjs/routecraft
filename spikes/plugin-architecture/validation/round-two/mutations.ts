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
    "saved.tail !== tailHash(route.steps, saved.pending)",
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
    "pending: saved.pending,",
    "pending: route.initial,",
    "defer → SIGKILL",
  ],
  [
    "defer fails to halt",
    "runtime.ts",
    "deferrals.push(continuationId);pending=[]",
    "deferrals.push(continuationId)",
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
    "const admitted=await this.handlers(route,'admission',this.attach(ingress),'resume');",
    "const admitted=ingress;",
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
  [
    "tag selector ignored",
    "runtime.ts",
    "(h.selector?.tag && !route.spec.tags.includes(h.selector.tag))",
    "false",
    "tag selector excludes",
  ],
  [
    "handler survival ignored",
    "runtime.ts",
    "!h.survival[kind] ||",
    "false ||",
    "declining resume",
  ],
  [
    "claimExpiry settles the record instead of claiming it",
    "storage.ts",
    "value: { ...saved, claimedAt: at } }]",
    'value: { ...saved, state: "expired" } }, { key: `waiting/${id}`, delete: true }]',
    "lease heals an expiry notification",
  ],
  [
    "claimExpiry ignores a live claim",
    "storage.ts",
    'if (!row || saved.state !== "waiting" || saved.claimedAt !== undefined) return "lost"; const won = await records.write( [{ key: `record/${id}`, value: { ...saved, claimedAt: at } }],',
    'if (!row || saved.state !== "waiting") return "lost"; const won = await records.write( [{ key: `record/${id}`, value: { ...saved, claimedAt: at } }],',
    "lease heals an expiry notification",
  ],
  [
    "releaseClaims ignores the lease deadline",
    "storage.ts",
    "if (!row || saved.claimedAt === undefined || saved.claimedAt > before)",
    "if (!row || saved.claimedAt === undefined || saved.claimedAt < before)",
    "lease heals an expiry notification",
  ],
  [
    "codec version ignored on resume",
    "runtime.ts",
    "saved.codec !== 1 ||",
    "false ||",
    "codec and pending are checked",
  ],
  [
    "unknown pending instruction accepted on resume",
    "runtime.ts",
    "saved.pending.some((x) => !route.steps.has(x)) ||",
    "false ||",
    "codec and pending are checked",
  ],
  [
    "callable source not folded into the tail hash",
    "runtime.ts",
    'typeof v === "function" ? Function.prototype.toString.call(v) : v,',
    'typeof v === "function" ? "fn" : v,',
    "plan hash covers the tail",
  ],
  [
    "continuation id sequence not advanced",
    "runtime.ts",
    "(Number(outcome.exchange.headers[DEFERRAL_SEQUENCE]) || 0) + 1;",
    "1;",
    "two defer points",
  ],
  [
    "resume without the compare-and-swap",
    "runtime.ts",
    "cas = await store.markResumed(id, Date.now());",
    'cas = "won"; await store.markResumed(id, Date.now());',
    "concurrent semantic resume",
  ],
  [
    "duplicate not answered from the cache",
    "runtime.ts",
    'if (record.state === "resumed") return {',
    "if (false) return {",
    "resume rechecks admission",
  ],
  [
    "failed resume not recorded",
    "runtime.ts",
    'store .recordOutcome(id, { status: "failed", exchanges: [], error: String(e), })',
    "Promise.resolve(void store)",
    "failed resume is recorded",
  ],
  [
    "duplicate deferral id accepted",
    "storage.ts",
    "[{ key: `record/${id}`, version: 0 }],",
    "[],",
    "second create under one id",
  ],
  [
    "sweep skips the expiry claim",
    "runtime.ts",
    'if ((await store.claimExpiry(id, now)) !== "won") continue;',
    "await store.claimExpiry(id, now);",
    "lease heals an expiry notification",
  ],
  [
    "defer boundary does not require plain JSON",
    "runtime.ts",
    "exchange: serialize(parked, step.owner),",
    "exchange: parked as unknown as SerializedExchange,",
    "arbitrary in flight",
  ],
  [
    "drain never times out",
    "runtime.ts",
    "if (left <= 0) {",
    "if (false) {",
    "bounded time",
  ],
  [
    "observers receive the live event payload",
    "host.ts",
    "Object.freeze({ name, data: structuredClone(data) })",
    "Object.freeze({ name, data })",
    "observers see their own copy",
  ],
  [
    "branch identity check dropped",
    "runtime.ts",
    "known.execute !== s.execute",
    "false",
    "substitute a different function",
  ],
  [
    "duplicate anchors accepted",
    "host.ts",
    "if (anchors.has(x.anchor.key))",
    "if (false)",
    "claiming one anchor",
  ],
  [
    "step context require ignores declaration",
    "runtime.ts",
    "require: (contract) => this.host.requireFor(step.owner, contract),",
    "require: (contract) => this.host.service(contract),",
    "plugin's declaration",
  ],
  [
    "late disposer accepted",
    "host.ts",
    'if (this.#phase === "stopped" || this.#phase === "stopping") throw new Fault(plugin.id, "LIFECYCLE", "late disposer");',
    'if (false) throw new Fault(plugin.id, "LIFECYCLE", "late disposer");',
    "disposer registered during teardown",
  ],
  [
    "compile after start accepted",
    "runtime.ts",
    'if (this.#accept) throw new Fault(spec.owner, "FROZEN", "route compilation");',
    'if (false) throw new Fault(spec.owner, "FROZEN", "route compilation");',
    "compiled after start",
  ],
  [
    "dispatch inherits the caller's run kind",
    "runtime.ts",
    'exchange: { ...wireExchange(exchange), routeId }, kind: "normal",',
    "exchange: { ...wireExchange(exchange), routeId }, kind: run.kind,",
    "dispatch from a resumed run",
  ],
  [
    "route requirement unchecked (authorization fails open)",
    "runtime.ts",
    "if (!this.host.has(port))",
    "if (false)",
    "requires authority does not boot",
  ],
  [
    "refusal at exit silently ignored",
    "runtime.ts",
    'if (point === "error" || point === "exit") {',
    "if (false) {",
    "refusal at exit or error",
  ],
  [
    "option key namespace unchecked",
    "runtime.ts",
    'dot < 1 || (prefix !== "route" && !this.host.namespaces.has(prefix))',
    "false",
    "owner-qualified",
  ],
  [
    "facet may be named anything",
    "dsl.ts",
    "if (key !== namespaceOf(plugin))",
    "if (false)",
    "owner-qualified",
  ],
  [
    "duplicate namespace accepted",
    "host.ts",
    "if (namespaces.has(ns))",
    "if (false)",
    "owner-qualified",
  ],
  [
    "contribution ids collide across plugins",
    "host.ts",
    "(x) => x.owner === plugin.id && x.id === c.id,",
    "(x) => x.id === c.id,",
    "owner-qualified",
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
