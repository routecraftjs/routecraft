import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, direct, noop, opsPlugin } from "@routecraft/routecraft";

const { chatCommand } = await import("../src/chat");
const { EXEC_EXIT } = await import("../src/exec");

/**
 * `craft chat`, driven against a real instance whose route answers in the
 * agent's own shape. The agent tier is not installed here: what the CLI
 * relies on is the reply's shape and the door, and a route that fakes
 * both keeps the test on the CLI's side of the wire.
 */

let cwd: string;
const isolated = (): { cwd: string; env: NodeJS.ProcessEnv } => ({
  cwd,
  env: {},
});
let context: TestContext | undefined;
let url: string;
/** Every message the route received, with its session. */
let received: Array<{ session: string; message: string }> = [];

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), "craft-chat-"));
});

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

afterEach(async () => {
  if (context) await context.stop();
  context = undefined;
  received = [];
});

async function start(tiers: Record<string, boolean | string>): Promise<void> {
  context = await testContext()
    .with({
      servers: { default: { port: 0, host: "127.0.0.1" } },
      plugins: [opsPlugin({ tiers })],
    })
    .routes([
      craft()
        .id("max")
        .from(direct())
        .transform((body) => {
          const { session, message } = body as {
            session: string;
            message: string;
          };
          received.push({ session, message });
          if (message === "busy") {
            return {
              text: "",
              session: {
                agent: "max",
                id: session,
                status: "queued",
                queued: 2,
              },
            };
          }
          if (message === "boom") throw new Error("model down");
          return {
            text: `reply ${received.length}: ${message}`,
            session: {
              agent: "max",
              id: session,
              status: "replied",
              queued: 0,
            },
          };
        })
        .to(noop()),
      craft()
        .id("inner")
        .from(direct({ internal: true }))
        .to(noop()),
    ])
    .build();
  let port: number | undefined;
  context.ctx.on("server:listening", ({ details }) => {
    port = details.port;
  });
  await context.startAndWaitReady();
  if (port === undefined) throw new Error("no server reported a port");
  url = `http://127.0.0.1:${String(port)}`;
}

describe("craft chat", () => {
  /**
   * @case Each line is one message to the same session and the reply is printed
   * @preconditions Dispatch open; two lines and a blank one on the input; a session id given
   * @expectedResult Both messages reach the route under the given session, in order, the blank line sends nothing, each reply's text is printed, and the header names the session for reattaching
   */
  test("holds a conversation on one session", async () => {
    await start({ dispatch: true });
    const out: string[] = [];
    const result = await chatCommand("max", {
      url,
      session: "feature-login",
      input: ["hello", "", "  what next?  "],
      write: (t) => out.push(t),
      ...isolated(),
    });
    expect(result.code).toBe(EXEC_EXIT.ok);
    expect(received).toEqual([
      { session: "feature-login", message: "hello" },
      { session: "feature-login", message: "what next?" },
    ]);
    expect(out[0]).toMatch(/Session feature-login on route "max"/);
    expect(out[0]).toMatch(/--session feature-login/);
    expect(out.slice(1)).toEqual(["reply 1: hello", "reply 2: what next?"]);
  });

  /**
   * @case Without --session a fresh id is minted, printed, and used for every message
   * @preconditions Dispatch open; no session given; two messages
   * @expectedResult The header carries the minted id and both dispatches carry the same one
   */
  test("mints a session when none is given", async () => {
    await start({ dispatch: true });
    const out: string[] = [];
    await chatCommand("max", {
      url,
      input: ["a", "b"],
      write: (t) => out.push(t),
      ...isolated(),
    });
    const minted = /Session (\S+) on route/.exec(out[0] ?? "")?.[1] ?? "";
    expect(minted).toMatch(/^[0-9a-f-]{36}$/);
    expect(received.map((r) => r.session)).toEqual([minted, minted]);
  });

  /**
   * @case A queued acknowledgement is said, not printed as an empty reply
   * @preconditions The route answers status queued with two waiting
   * @expectedResult The printed line says the message is delivered at the turn boundary and how many are waiting; under raw it is empty
   */
  test("says when a message was queued", async () => {
    await start({ dispatch: true });
    const out: string[] = [];
    await chatCommand("max", {
      url,
      session: "s",
      input: ["busy"],
      write: (t) => out.push(t),
      ...isolated(),
    });
    expect(out[1]).toMatch(/queued: a turn is running.*2 waiting/);
    const raw: string[] = [];
    await chatCommand("max", {
      url,
      session: "s",
      format: "raw",
      input: ["busy", "fine"],
      write: (t) => raw.push(t),
      ...isolated(),
    });
    expect(raw).toEqual(["", "reply 3: fine"]);
  });

  /**
   * @case A route failure on one message does not end the conversation
   * @preconditions A message the route throws on, followed by one it answers
   * @expectedResult The failure is printed with its code and the next message is still answered, exit 0
   */
  test("continues past a failed message", async () => {
    await start({ dispatch: true });
    const out: string[] = [];
    const result = await chatCommand("max", {
      url,
      session: "s",
      input: ["boom", "still here?"],
      write: (t) => out.push(t),
      ...isolated(),
    });
    expect(result.code).toBe(EXEC_EXIT.ok);
    expect(out[1]).toMatch(/the route failed/);
    expect(out[2]).toBe("reply 2: still here?");
  });

  /**
   * @case Under json a failed message is still one JSON object on standard output
   * @preconditions Format json; a message the route throws on, followed by one it answers
   * @expectedResult The failure line parses as JSON with outcome "failed" and the route's error code, the next reply is a JSON dispatch outcome, exit 0
   */
  test("keeps the json stream well formed past a failed message", async () => {
    await start({ dispatch: true });
    const out: string[] = [];
    const result = await chatCommand("max", {
      url,
      session: "s",
      format: "json",
      input: ["boom", "still here?"],
      write: (t) => out.push(t),
      ...isolated(),
    });
    expect(result.code).toBe(EXEC_EXIT.ok);
    expect(out).toHaveLength(2);
    const failed = JSON.parse(out[0] ?? "") as {
      outcome: string;
      message: string;
      code?: string;
    };
    expect(failed.outcome).toBe("failed");
    expect(failed.message).toMatch(/500/);
    expect(failed.code).toMatch(/^RC\d{4}$/);
    expect(JSON.parse(out[1] ?? "")).toMatchObject({
      outcome: "completed",
      body: { text: "reply 2: still here?" },
    });
  });

  /**
   * @case Under json and raw a minted session id goes to standard error, not into the reply stream
   * @preconditions No session given; format json, then raw; one message each
   * @expectedResult Standard error carries the minted id with the flag to reattach, standard output holds only the reply, and the dispatch carried that id
   */
  test("prints a minted session on stderr under json and raw", async () => {
    await start({ dispatch: true });
    for (const format of ["json", "raw"] as const) {
      const out: string[] = [];
      const err: string[] = [];
      await chatCommand("max", {
        url,
        format,
        input: ["hi"],
        write: (t) => out.push(t),
        writeStderr: (t) => err.push(t),
        ...isolated(),
      });
      const minted = /--session (\S+)/.exec(err.join("\n"))?.[1] ?? "";
      expect(minted).toMatch(/^[0-9a-f-]{36}$/);
      expect(received.at(-1)?.session).toBe(minted);
      expect(out).toHaveLength(1);
      expect(out[0]).not.toContain("--session");
    }
  });

  /**
   * @case A given session is not announced on stderr
   * @preconditions Format raw; --session given; one message
   * @expectedResult Nothing is written to standard error
   */
  test("says nothing on stderr when the session was given", async () => {
    await start({ dispatch: true });
    const err: string[] = [];
    await chatCommand("max", {
      url,
      session: "s",
      format: "raw",
      input: ["hi"],
      write: () => undefined,
      writeStderr: (t) => err.push(t),
      ...isolated(),
    });
    expect(err).toEqual([]);
  });

  /**
   * @case A route with no dispatch door ends the conversation as a usage error
   * @preconditions Dispatch open; the route is declared internal (answers 409); two lines of input
   * @expectedResult Exit 2 after the first message with the instance's reason, and the second message is never sent
   */
  test("stops at a route that cannot be dispatched", async () => {
    await start({ dispatch: true });
    const out: string[] = [];
    let sent = 0;
    const input = (function* () {
      for (const line of ["one", "two"]) {
        sent += 1;
        yield line;
      }
    })();
    const result = await chatCommand("inner", {
      url,
      session: "s",
      input,
      write: (t) => out.push(t),
      ...isolated(),
    });
    expect(result.code).toBe(EXEC_EXIT.usage);
    expect(result.error).toMatch(/not dispatchable/);
    expect(sent).toBe(1);
    expect(out.filter((line) => line.includes("route failed"))).toEqual([]);
  });

  /**
   * @case Every reply write is awaited before the command resolves
   * @preconditions A writer whose promise settles on a later tick; two messages
   * @expectedResult The second dispatch starts only after the first write settled, and the command resolves after the last write settled, so an exit that follows cannot drop a reply still queued on a pipe
   */
  test("awaits each write before going on", async () => {
    await start({ dispatch: true });
    const events: string[] = [];
    const write = (text: string): Promise<void> =>
      new Promise((resolve) => {
        events.push(`write:${text}`);
        setTimeout(() => {
          events.push(`flushed:${text}`);
          resolve();
        }, 20);
      });
    const input = (function* () {
      for (const line of ["a", "b"]) {
        events.push(`send:${line}`);
        yield line;
      }
    })();
    await chatCommand("max", {
      url,
      session: "s",
      format: "raw",
      input,
      write,
      ...isolated(),
    });
    events.push("resolved");
    expect(events).toEqual([
      "send:a",
      "write:reply 1: a",
      "flushed:reply 1: a",
      "send:b",
      "write:reply 2: b",
      "flushed:reply 2: b",
      "resolved",
    ]);
  });

  /**
   * @case A door that refuses ends the loop with exec's refusal code and sends nothing more
   * @preconditions Dispatch disabled (answers 404); three lines of input
   * @expectedResult Exit 4 after the first message and the route received nothing
   */
  test("stops at a refused door", async () => {
    await start({});
    const out: string[] = [];
    const result = await chatCommand("max", {
      url,
      session: "s",
      input: ["one", "two", "three"],
      write: (t) => out.push(t),
      ...isolated(),
    });
    expect(result.code).toBe(EXEC_EXIT.refused);
    expect(received).toEqual([]);
  });

  /**
   * @case No route is a usage error carrying the usage text
   * @preconditions chat invoked without a route
   * @expectedResult Exit 2 and a message naming --session and what the route must accept
   */
  test("needs a route", async () => {
    const result = await chatCommand(undefined, { ...isolated() });
    expect(result.code).toBe(EXEC_EXIT.usage);
    expect(result.error).toMatch(/--session/);
    expect(result.error).toMatch(/\{ session, message \}/);
  });
});
