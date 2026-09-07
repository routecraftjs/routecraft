/**
 * `craft acp`, the pipe an editor runs.
 *
 * It is a pipe and the tests treat it as one: a real editor-side stream on
 * one end, a real instance speaking the protocol on the other, and the
 * assertions are about what arrived unchanged and what credential it
 * arrived with. The instance is stopped and started again under an open
 * editor, because that is what a restart looks like from the editor's
 * chair, and the pipe is expected to still be there afterwards.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { agent as acpAgent, RequestError } from "@agentclientprotocol/sdk";
import { createNodeHttpHandler } from "@agentclientprotocol/sdk/experimental/node";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";

import { acpCommand, ACP_AGENT_HEADER, type AcpResult } from "../src/acp.js";

/** What one stub instance recorded about the requests it served. */
interface Served {
  readonly url: string;
  readonly port: number;
  readonly stop: () => void;
  readonly authorizations: Array<string | null>;
  readonly agents: Array<string | null>;
  /** Every prompt the editor's messages reached the agent with. */
  readonly prompts: string[];
  /** Every protocol method the agent handled, in order. */
  readonly methods: string[];
  /** The session ids `session/resume` was asked for. */
  readonly resumed: string[];
  /** Let a held prompt finish. */
  readonly release: () => void;
}

interface ServeOptions {
  /** Listen here rather than on a free port: an instance coming back. */
  readonly port?: number;
  /** Whether `session/resume` finds the conversation. */
  readonly resume?: "found" | "gone";
  /** A method whose handler waits for `release()` before answering. */
  readonly hold?: "session/prompt" | "session/new";
}

/**
 * A real instance, built from the SDK's own server, so the bridge is
 * exercised against the protocol rather than against a mock of it.
 */
function serve(options: ServeOptions = {}): Served {
  const authorizations: Array<string | null> = [];
  const agents: Array<string | null> = [];
  const prompts: string[] = [];
  const methods: string[] = [];
  const resumed: string[] = [];
  let release = (): void => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  const app = acpAgent({ name: "stub" })
    .onRequest("initialize", () => {
      methods.push("initialize");
      return {
        protocolVersion: 1,
        agentInfo: { name: "stub", title: "Stub", version: "0.0.0" },
        authMethods: [],
      };
    })
    .onRequest("session/new", async () => {
      methods.push("session/new");
      if (options.hold === "session/new") await released;
      return { sessionId: "session-1" };
    })
    .onRequest("session/resume", ({ params }) => {
      methods.push("session/resume");
      resumed.push(params.sessionId);
      if (options.resume === "gone") {
        throw RequestError.invalidParams("No such session.");
      }
      return {};
    })
    .onRequest("session/prompt", async ({ params, client }) => {
      methods.push("session/prompt");
      prompts.push(
        params.prompt
          .map((block) => (block.type === "text" ? block.text : ""))
          .join(""),
      );
      if (options.hold === "session/prompt") await released;
      await client.notify("session/update", {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "pong" },
        },
      });
      return { stopReason: "end_turn" as const };
    });

  const server = new AcpServer({ createAgent: () => app });
  const handler = createNodeHttpHandler(server);
  const listener = createServer((request, response) => {
    authorizations.push(request.headers["authorization"] ?? null);
    agents.push(
      (request.headers[ACP_AGENT_HEADER.toLowerCase()] as string | undefined) ??
        null,
    );
    handler(request, response);
  });
  listener.listen(options.port ?? 0, "127.0.0.1");

  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    stop: () => {
      // Both halves: `close()` alone stops new connections while leaving
      // the established one open, which is a server draining rather than
      // an instance going away.
      listener.closeAllConnections?.();
      listener.close();
    },
    authorizations,
    agents,
    prompts,
    methods,
    resumed,
    release: () => release(),
  };
}

/** A JSON-RPC message as the editor side reads it back. */
interface Seen {
  id?: number | string;
  method?: string;
  result?: { stopReason?: string; sessionId?: string };
  error?: { code: number; message: string };
}

/** One editor's side of the pipe: what it writes, and what it read back. */
function editorSide(lines: readonly string[]): {
  stdin: ReadableStream<Uint8Array>;
  stdout: WritableStream<Uint8Array>;
  read: () => Seen[];
  /** Write one more line, as an editor does while the window stays open. */
  send: (message: object) => void;
  finish: () => void;
} {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const written: string[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;

  const stdin = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      for (const line of lines) {
        c.enqueue(encoder.encode(`${line}\n`));
      }
    },
  });
  const stdout = new WritableStream<Uint8Array>({
    write(chunk) {
      written.push(decoder.decode(chunk));
    },
  });
  return {
    stdin,
    stdout,
    read: () =>
      written
        .join("")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Seen),
    send: (message) =>
      controller?.enqueue(encoder.encode(`${JSON.stringify(message)}\n`)),
    finish: () => controller?.close(),
  };
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: 1, clientCapabilities: {} },
});
const NEW_SESSION = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  method: "session/new",
  params: { cwd: "/work", mcpServers: [] },
});
function prompt(id: number, text: string): object {
  return {
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: { sessionId: "session-1", prompt: [{ type: "text", text }] },
  };
}

describe("craft acp", () => {
  const roots: string[] = [];
  const instances: Served[] = [];

  afterEach(() => {
    for (const instance of instances.splice(0)) instance.stop();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function up(options: ServeOptions = {}): Served {
    const instance = serve(options);
    instances.push(instance);
    return instance;
  }

  function settings(contents: string): string {
    const root = mkdtempSync(join(tmpdir(), "craft-acp-"));
    roots.push(root);
    mkdirSync(join(root, ".routecraft"), { recursive: true });
    writeFileSync(join(root, ".routecraft", "settings.yaml"), contents, "utf8");
    return root;
  }

  /** An empty home, so nobody's own settings decide what a case resolves to. */
  function emptyHome(): string {
    const root = mkdtempSync(join(tmpdir(), "craft-acp-home-"));
    roots.push(root);
    return root;
  }

  /**
   * Runs the bridge against one instance and one editor side: the shape
   * every case shares except the ones exercising settings resolution or an
   * address nothing is listening on.
   */
  function bridge(
    instance: Served,
    editor: {
      stdin: ReadableStream<Uint8Array>;
      stdout: WritableStream<Uint8Array>;
    },
    stderr: (line: string) => void = () => undefined,
  ): Promise<AcpResult> {
    return acpCommand({
      url: instance.url,
      cwd: settings(""),
      home: emptyHome(),
      env: {},
      stdin: editor.stdin,
      stdout: editor.stdout,
      stderr,
    });
  }

  /**
   * @case A request and a notification cross the bridge in both directions, unchanged
   * @preconditions A stub instance speaking the protocol, and an editor writing an initialize, a session/new and a prompt
   * @expectedResult The prompt reaches the instance as written and the agent's own notification and response reach the editor, so the bridge is a pipe rather than a participant
   */
  test("forwards a request and a notification both ways", async () => {
    const instance = up();
    const editor = editorSide([
      INITIALIZE,
      NEW_SESSION,
      JSON.stringify(prompt(3, "ping")),
    ]);

    const running = bridge(instance, editor);
    // Give the three messages their round trips, then close the editor's
    // side, which is what closing an editor tab looks like from here.
    await waitFor(() => editor.read().length >= 4);
    editor.finish();
    const result = await running;

    expect(result.code).toBe(0);
    expect(instance.prompts).toEqual(["ping"]);
    const seen = editor.read();
    expect(seen.find((message) => message.id === 1)?.result).toBeDefined();
    expect(
      seen.find((message) => message.method === "session/update"),
    ).toBeDefined();
    expect(seen.find((message) => message.id === 3)?.result?.stopReason).toBe(
      "end_turn",
    );
  });

  /**
   * @case A profile's token authenticates the bridge, exactly as it does every other command
   * @preconditions A settings file whose selected profile carries a url and a token
   * @expectedResult Every request the bridge made carried that bearer, so no login flow is needed for an editor to reach a walled instance
   */
  test("a profile's token is presented on every request", async () => {
    const instance = up();
    const cwd = settings(`
profile: company
profiles:
  company:
    url: ${instance.url}
    token: paste-me
    agent: zoe
`);
    const editor = editorSide([INITIALIZE]);

    const running = acpCommand({
      cwd,
      home: emptyHome(),
      env: {},
      stdin: editor.stdin,
      stdout: editor.stdout,
    });
    await waitFor(() => editor.read().length >= 1);
    editor.finish();
    await running;

    expect(instance.authorizations.length).toBeGreaterThan(0);
    for (const value of instance.authorizations) {
      expect(value).toBe("Bearer paste-me");
    }
    // And the agent the profile names travels with it, because the
    // protocol has no field for one.
    expect(instance.agents.some((value) => value === "zoe")).toBe(true);
  });

  /**
   * @case A settings file that cannot be used stops the bridge rather than reaching the default
   * @preconditions A flag naming a profile the files do not define
   * @expectedResult A non-zero exit and a message naming the profiles that exist, on standard error, because standard output belongs to the protocol
   */
  test("a missing profile stops the bridge", async () => {
    const cwd = settings(`
profiles:
  local:
    url: http://127.0.0.1:9999
`);
    const result = await acpCommand({
      cwd,
      home: emptyHome(),
      env: {},
      profile: "staging",
    });
    expect(result.code).toBe(2);
    expect(result.error).toContain('No profile "staging"');
    expect(result.error).toContain("local");
  });

  /**
   * @case An instance that is not there is reported as such rather than waited for
   * @preconditions A url nothing is listening on, and a bridge that has never connected
   * @expectedResult A non-zero exit naming the address and where the address came from, which is the first thing to check: an address that never answered is configuration, not an outage, and waiting on it would hide a typo behind a silent editor
   */
  test("an unreachable instance names the address and its source", async () => {
    const editor = editorSide([INITIALIZE]);
    const result = await settledWithin(
      acpCommand({
        url: "http://127.0.0.1:1",
        cwd: settings(""),
        home: emptyHome(),
        env: {},
        stdin: editor.stdin,
        stdout: editor.stdout,
      }),
      5_000,
    );
    expect(result).not.toBe(TIMED_OUT);
    const settled = result as { code: number; error?: string };
    // The family's code for an address nothing answered on, so one script
    // reads a failed `exec` and a failed `acp` the same way.
    expect(settled.code).toBe(3);
    expect(settled.error).toContain("http://127.0.0.1:1/acp");
    expect(settled.error).toContain("flag");
    expect(settled.error).not.toContain("abort");
    expect(settled.error).not.toContain("Abort");
  });

  /**
   * @case The instance going away does not end the bridge while the editor keeps it open; the editor closing does
   * @preconditions A connected bridge whose instance is stopped, with the editor's stdin deliberately left open, which is what an open editor window looks like from here
   * @expectedResult The command does not settle while the editor is open: the editor would not start another process, so exiting would leave the window dead until the editor restarts. Standard error says the connection was lost and is being waited for. Closing the editor's side then ends it cleanly with exit 0
   */
  test("the instance going away is waited out while the editor stays open", async () => {
    const instance = up();
    const editor = editorSide([INITIALIZE]);
    const lines: string[] = [];

    const running = bridge(instance, editor, (line) => lines.push(line));
    // Connected: the reply came back, so both directions are live.
    await waitFor(() => editor.read().length >= 1);

    instance.stop();
    expect(await settledWithin(running, 1_000)).toBe(TIMED_OUT);
    expect(lines.some((line) => line.startsWith("Lost the connection"))).toBe(
      true,
    );

    editor.finish();
    const result = await settledWithin(running, 5_000);
    expect(result).toEqual({ code: 0 });
  });

  /**
   * @case The instance coming back on the same address is reconnected to, and the conversation continues where it was
   * @preconditions A bridge with a session open, whose instance is stopped and started again on the same port while the editor keeps its window open
   * @expectedResult The editor's next prompt is answered by the new instance without the editor doing anything: the bridge initialized the new instance itself and resumed the session by its id (resumed rather than loaded, so nothing is replayed onto a screen that already shows it), and standard error records the loss and the reconnection
   */
  test("reconnects when the instance comes back and resumes the session", async () => {
    const first = up();
    const editor = editorSide([INITIALIZE, NEW_SESSION]);
    const lines: string[] = [];

    const running = bridge(first, editor, (line) => lines.push(line));
    await waitFor(() => editor.read().length >= 2);

    first.stop();
    await waitFor(() => lines.some((line) => line.startsWith("Lost the")));
    const second = up({ port: first.port });
    // Typed after the restart, as a person would; the bridge is still
    // reconnecting, so this waits in its queue until the handshake is done.
    editor.send(prompt(3, "still there?"));

    await waitFor(
      () => editor.read().some((message) => message.id === 3),
      10_000,
    );
    const answer = editor.read().find((message) => message.id === 3);
    expect(answer?.result?.stopReason).toBe("end_turn");
    expect(second.prompts).toEqual(["still there?"]);
    // The handshake the editor never saw: initialize, then the resume.
    expect(second.methods.slice(0, 2)).toEqual([
      "initialize",
      "session/resume",
    ]);
    expect(second.resumed).toEqual(["session-1"]);
    // The editor did not see the bridge's own exchanges, only its own.
    expect(editor.read().filter((message) => message.id === 1)).toHaveLength(1);
    expect(lines.some((line) => line.startsWith("Reconnected to"))).toBe(true);

    editor.finish();
    expect(await settledWithin(running, 5_000)).toEqual({ code: 0 });
  }, 20_000);

  /**
   * @case A prompt that was in flight when the instance went away is answered as cancelled, and the next one is answered by the new instance
   * @preconditions A bridge whose instance holds a prompt open and is then stopped, and started again
   * @expectedResult The editor's waiting prompt gets `cancelled` rather than hanging or an error, because the protocol does not replay what a dead transport had in flight and a turn that ended with no reply is what cancelled means; a prompt sent after the restart is answered normally
   */
  test("a prompt in flight during the outage is cancelled, the next one answered", async () => {
    const first = up({ hold: "session/prompt" });
    const editor = editorSide([
      INITIALIZE,
      NEW_SESSION,
      JSON.stringify(prompt(3, "slow one")),
    ]);

    const lines: string[] = [];
    const running = bridge(first, editor, (line) => lines.push(line));
    await waitFor(() => first.prompts.length === 1);

    first.stop();
    await waitFor(() => editor.read().some((message) => message.id === 3));
    expect(
      editor.read().find((message) => message.id === 3)?.result?.stopReason,
    ).toBe("cancelled");

    const second = up({ port: first.port });
    editor.send(prompt(4, "after"));
    await waitFor(
      () =>
        editor.read().find((message) => message.id === 4)?.result
          ?.stopReason === "end_turn",
      10_000,
    );
    expect(second.prompts).toEqual(["after"]);

    editor.finish();
    expect(await settledWithin(running, 5_000)).toEqual({ code: 0 });
  }, 20_000);

  /**
   * @case Any other request in flight when the instance goes away is answered with an error naming the outage
   * @preconditions A bridge whose instance holds a `session/new` open and is then stopped
   * @expectedResult The editor's waiting request gets a JSON-RPC error rather than hanging: only a prompt has a stop reason to carry the outage in, so every other request is told in the error what happened and that it was not answered
   */
  test("another request in flight during the outage gets an error naming it", async () => {
    const first = up({ hold: "session/new" });
    const editor = editorSide([INITIALIZE, NEW_SESSION]);

    const running = bridge(first, editor);
    await waitFor(() => first.methods.includes("session/new"));

    first.stop();
    await waitFor(() => editor.read().some((message) => message.id === 2));
    const answer = editor.read().find((message) => message.id === 2);
    expect(answer?.result).toBeUndefined();
    expect(answer?.error?.code).toBe(-32000);
    expect(answer?.error?.message).toContain("Lost the connection");
    expect(answer?.error?.message).toContain("session/new");

    editor.finish();
    expect(await settledWithin(running, 5_000)).toEqual({ code: 0 });
  });

  /**
   * @case A conversation the instance came back without is reported, and the bridge still serves the rest
   * @preconditions A bridge with a session open, whose instance restarts with a store that did not keep it, so `session/resume` is refused
   * @expectedResult Standard error names the conversation and says to start a new one; a `session/new` the editor sends afterwards is served, so a lost conversation is a lost conversation and not a dead editor
   */
  test("a conversation the instance came back without is named, and new ones work", async () => {
    const first = up();
    const editor = editorSide([INITIALIZE, NEW_SESSION]);
    const lines: string[] = [];

    const running = bridge(first, editor, (line) => lines.push(line));
    await waitFor(() => editor.read().length >= 2);

    first.stop();
    await waitFor(() => lines.some((line) => line.startsWith("Lost the")));
    const second = up({ port: first.port, resume: "gone" });
    editor.send({
      jsonrpc: "2.0",
      id: 5,
      method: "session/new",
      params: { cwd: "/work", mcpServers: [] },
    });

    await waitFor(
      () => editor.read().some((message) => message.id === 5),
      10_000,
    );
    expect(
      editor.read().find((message) => message.id === 5)?.result?.sessionId,
    ).toBe("session-1");
    expect(second.resumed).toEqual(["session-1"]);
    expect(
      lines.some(
        (line) =>
          line.includes("session-1") && line.includes("Start a new one"),
      ),
    ).toBe(true);

    editor.finish();
    expect(await settledWithin(running, 5_000)).toEqual({ code: 0 });
  }, 20_000);

  /**
   * @case The editor closing ends the bridge cleanly
   * @preconditions A connected bridge whose editor closes its side first
   * @expectedResult Exit 0 and no error. This is the ordinary end of a session, and the sibling direction being cancelled by it must not turn a clean close into a reported failure
   */
  test("the editor closing ends the bridge cleanly", async () => {
    const instance = up();
    const editor = editorSide([INITIALIZE]);

    const running = bridge(instance, editor);
    await waitFor(() => editor.read().length >= 1);
    editor.finish();

    const result = await settledWithin(running, 5_000);
    expect(result).not.toBe(TIMED_OUT);
    expect(result).toEqual({ code: 0 });
  });
});

/** What {@link settledWithin} answers with when the promise never settles. */
const TIMED_OUT = Symbol("timed out");

/**
 * Await a promise, or report that it never settled.
 *
 * A bridge that fails to shut down hangs rather than fails, and a hung
 * test reports as a suite timeout naming nothing. This turns the hang into
 * an assertion that names what did not happen.
 */
async function settledWithin<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Wait for a condition, bounded, so a failure reports rather than hangs. */
async function waitFor(condition: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(condition()).toBe(true);
}
