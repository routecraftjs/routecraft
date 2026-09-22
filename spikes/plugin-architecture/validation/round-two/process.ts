/** Child process probe. Each invocation has a fresh JS heap and fresh SQLite connections. */
import {
  appendFileSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import {
  application,
  infrastructure,
  operations,
  resilience,
  deferral,
  sqlite,
  auth,
  principals,
  withPrincipal,
  ENFORCEMENT,
  CONTINUATIONS,
  SESSIONS,
  RECORDS,
  SqliteRecords,
  instruction,
  continueWith,
  type AtomicStore,
  type Step,
  type RouteSpec,
} from "../../src/v2/index.ts";
const [mode, dir] = process.argv.slice(2);
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
  const arg = process.argv[4];
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
  const app = application([
    operations,
    resilience,
    deferral,
    principals,
    auth,
    sqlite(`${dir}/deferrals.db`, "acme.disk", true),
    sqlite(`${dir}/sessions.db`, "acme.sessions", true, SESSIONS),
    agent,
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
        request: { name: "approval", reason: "tool", reenter: true },
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
  // The sink authorises at its own admission. A continuation reaches it as the
  // restored principal that parked, whoever resumed it, so it refuses.
  const target: RouteSpec = {
    id: "sink",
    owner: "acme.agent",
    version: "1",
    tags: [],
    requires: [ENFORCEMENT],
    options: { "auth.authorize": ["approve"] },
    steps: [
      op("sink-check", (ex) => {
        log("sink-ran");
        return continueWith(ex);
      }),
    ],
  };
  const spec: RouteSpec = {
    id: "conversation",
    owner: "acme.agent",
    version: "1",
    tags: ["agent"],
    steps: [
      op("prefix", (ex) => {
        log("prefix");
        return continueWith(ex);
      }),
      nested,
      op(
        "suffix",
        mode === "mismatch"
          ? async (ex) => {
              log("suffix-edited");
              return continueWith(ex);
            }
          : async (ex, ctx) => {
              log("suffix");
              const view = (
                ex as {
                  auth?: {
                    principal?: { subject: string; authentic: boolean };
                    resumedBy?: { subject: string; authentic: boolean };
                  };
                }
              ).auth;
              const p = view?.principal,
                by = view?.resumedBy;
              log(
                `principal:${p?.subject}:${p?.authentic ? "authentic" : "restored"}`,
              );
              log(
                `resumedBy:${by?.subject}:${by?.authentic ? "authentic" : "restored"}`,
              );
              log(`sink:${(await ctx.dispatch("sink", ex)).status}`);
              return continueWith(ex);
            },
      ),
    ],
  };
  await app.start([spec, target]);
  const parkedId = () =>
    JSON.parse(readFileSync(`${dir}/parked.json`, "utf8")).id as string;
  if (mode === "park") {
    const result = await app.runtime.deliver(
      "conversation",
      "book",
      withPrincipal({}, { subject: "alice", grants: [], lent: ["approve"] }),
    );
    writeFileSync(
      `${dir}/parked.json`,
      JSON.stringify({
        pid: process.pid,
        id: result.deferrals[0],
        result,
        plan: app.runtime.dump(),
        session: await session.get("conversation"),
      }),
    );
    await pause();
  } else if (mode === "resume") {
    const ingress = withPrincipal(
      {},
      { subject: "bob", grants: ["approve"], lent: [] },
    );
    const result = await app.runtime.resume(parkedId(), { headers: ingress });
    const again = await app.runtime.resume(parkedId(), { headers: ingress });
    writeFileSync(
      `${dir}/resumed.json`,
      JSON.stringify({
        pid: process.pid,
        result,
        again,
        session: await session.get("conversation"),
        waiting: await app.host.service(RECORDS).keys("waiting/"),
      }),
    );
    await app.stop();
  } else if (mode === "mismatch") {
    // The suffix callable was edited under a parked approval. A copy of the
    // real record takes the hit, because a mismatch settles the record it is
    // found on: denied, with the route told through its error channel.
    const store = app.host.service(CONTINUATIONS);
    const copy = `${parkedId()}-edited`;
    await store.create(copy, (await store.get(parkedId()))!.continuation);
    try {
      await app.runtime.resume(copy);
      throw Error("accepted changed plan");
    } catch (e) {
      writeFileSync(
        `${dir}/mismatch.txt`,
        JSON.stringify({
          error: String(e),
          copy: await store.get(copy),
          original: await store.get(parkedId()),
        }),
      );
    }
    await app.stop();
  }
}
