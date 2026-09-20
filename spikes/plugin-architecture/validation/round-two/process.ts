/** Child process probe. Each invocation has a fresh JS heap and fresh SQLite connections. */
import { appendFileSync, writeFileSync, existsSync } from "node:fs";
import {
  application,
  infrastructure,
  operations,
  resilience,
  deferral,
  sqlite,
  SESSIONS,
  RECORDS,
  SqliteRecords,
  allRuns,
  instruction,
  continueWith,
  type AtomicStore,
  type Step,
  type RouteSpec,
} from "../../src/v2/index.ts";
const [mode, dir, arg] = process.argv.slice(2);
if (!dir) throw Error("missing directory");
const pause = async () => {
  while (true) await new Promise((r) => setTimeout(r, 100));
};
if (mode === "crash") {
  const s = new SqliteRecords(`${dir}/crash.db`);
  s.write(
    [
      { key: "record/x", value: 1 },
      { key: "waiting/x", value: null },
    ],
    [],
    (index) => {
      if (index === 0) {
        writeFileSync(`${dir}/between-writes`, "ready");
        process.kill(process.pid, "SIGKILL");
      }
    },
  );
  throw Error("kill failed");
} else if (mode === "cas") {
  const s = new SqliteRecords(`${dir}/cas.db`);
  const version = s.get("latch")!.version;
  writeFileSync(`${dir}/ready-${arg}`, String(process.pid));
  while (!existsSync(`${dir}/go`)) await new Promise((r) => setTimeout(r, 2));
  const won = s.write(
    [{ key: "latch", value: arg }],
    [{ key: "latch", version }],
  );
  writeFileSync(`${dir}/won-${arg}`, String(won));
  s.close();
} else {
  const log = (event: string) =>
    appendFileSync(`${dir}/effects.log`, `${event}\n`);
  let session!: AtomicStore;
  const agent = infrastructure({
    id: "acme.agent",
    requires: [SESSIONS],
    bind(c) {
      session = c.require(SESSIONS);
    },
  });
  const security = infrastructure({
    id: "acme.security",
    bind(c) {
      c.contribute({
        kind: "handler",
        id: "admit",
        point: "admission",
        survival: allRuns,
        handle(ex, { kind }) {
          if (kind === "resume" && !ex.principal.lent.includes("approve"))
            throw Error("lost elevation");
          return { kind: "allow", exchange: ex };
        },
      });
      c.contribute({
        kind: "handler",
        id: "authorize",
        point: "entry",
        survival: allRuns,
        handle(ex) {
          if (
            ![...ex.principal.grants, ...ex.principal.lent].includes("approve")
          )
            return { kind: "refuse", reason: "authorize" };
          return { kind: "allow", exchange: ex };
        },
      });
    },
  });
  const app = application([
    operations,
    resilience,
    deferral,
    sqlite(`${dir}/deferrals.db`, "acme.disk", true),
    sqlite(`${dir}/sessions.db`, "acme.sessions", true, SESSIONS),
    agent,
    security,
  ]);
  const op = (
    id: string,
    fn: Step["execute"],
    children: readonly Step[] = [],
  ) => instruction("acme.agent", id, fn, children);
  const ask = op("agent/tool-approval", async (ex, context) => {
    const row = await session.get("conversation");
    if (!row) {
      await session.write([
        {
          key: "conversation",
          value: {
            messages: ["user:book", "assistant:tool-request"],
            phase: "awaiting",
          },
        },
      ]);
      log("tool-request");
      return {
        kind: "defer",
        exchange: ex,
        request: { id: "approval", reason: "tool", reenter: true },
      };
    }
    if (context.kind !== "resume") throw Error("approval required");
    await session.write([
      {
        key: "conversation",
        value: {
          messages: [
            "user:book",
            "assistant:tool-request",
            "tool:approved",
            "assistant:done",
          ],
          phase: "done",
        },
      },
    ]);
    log("tool-result");
    return continueWith(ex);
  });
  const nested = op(
    "choose-agent",
    (ex) => ({ kind: "branch", exchange: ex, steps: [ask] }),
    [ask],
  );
  const target: RouteSpec = {
    id: "sink",
    owner: "acme.agent",
    version: "1",
    tags: [],
    steps: [
      op("sink-check", (ex) => {
        log(`principal:${ex.principal.subject}:${ex.principal.lent.join(",")}`);
        return continueWith(ex);
      }),
    ],
  };
  const spec: RouteSpec = {
    id: "conversation",
    owner: "acme.agent",
    version: mode === "mismatch" ? "changed" : "1",
    tags: ["agent"],
    steps: [
      op("prefix", (ex) => {
        log("prefix");
        return continueWith(ex);
      }),
      nested,
      op("suffix", async (ex, ctx) => {
        log("suffix");
        await ctx.dispatch("sink", ex);
        return continueWith(ex);
      }),
    ],
  };
  await app.start([spec, target]);
  if (mode === "park") {
    const result = await app.runtime.deliver("conversation", "book", {
      subject: "alice",
      grants: [],
      lent: ["approve"],
    });
    writeFileSync(
      `${dir}/parked.json`,
      JSON.stringify({
        pid: process.pid,
        result,
        plan: app.runtime.dump(),
        session: await session.get("conversation"),
      }),
    );
    await pause();
  } else if (mode === "resume") {
    const result = await app.runtime.resume("approval");
    writeFileSync(
      `${dir}/resumed.json`,
      JSON.stringify({
        pid: process.pid,
        result,
        session: await session.get("conversation"),
        waiting: await app.host.service(RECORDS).keys("waiting/"),
      }),
    );
    await app.stop();
  } else if (mode === "mismatch") {
    try {
      await app.runtime.resume("approval");
      throw Error("accepted changed plan");
    } catch (e) {
      writeFileSync(`${dir}/mismatch.txt`, String(e));
    }
    await app.stop();
  }
}
