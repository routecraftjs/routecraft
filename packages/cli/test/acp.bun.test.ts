/**
 * `craft acp`, the pipe an editor runs.
 *
 * It is a pipe and the tests treat it as one: a real editor-side stream on
 * one end, a real instance speaking the protocol on the other, and the
 * assertions are about what arrived unchanged and what credential it
 * arrived with.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { agent as acpAgent } from "@agentclientprotocol/sdk";
import { createNodeHttpHandler } from "@agentclientprotocol/sdk/experimental/node";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";

import { acpCommand, ACP_AGENT_HEADER } from "../src/acp.js";

/** What one stub instance recorded about the requests it served. */
interface Served {
  readonly url: string;
  readonly stop: () => void;
  readonly authorizations: Array<string | null>;
  readonly agents: Array<string | null>;
  /** Every prompt the editor's messages reached the agent with. */
  readonly prompts: string[];
}

/**
 * A real instance, built from the SDK's own server, so the bridge is
 * exercised against the protocol rather than against a mock of it.
 */
function serve(): Served {
  const authorizations: Array<string | null> = [];
  const agents: Array<string | null> = [];
  const prompts: string[] = [];

  const app = acpAgent({ name: "stub" })
    .onRequest("initialize", () => ({
      protocolVersion: 1,
      agentInfo: { name: "stub", title: "Stub", version: "0.0.0" },
      authMethods: [],
    }))
    .onRequest("session/new", () => ({ sessionId: "session-1" }))
    .onRequest("session/prompt", async ({ params, client }) => {
      prompts.push(
        params.prompt
          .map((block) => (block.type === "text" ? block.text : ""))
          .join(""),
      );
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
  listener.listen(0, "127.0.0.1");

  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
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
  };
}

/** One editor's side of the pipe: what it writes, and what it read back. */
function editorSide(lines: readonly string[]): {
  stdin: ReadableStream<Uint8Array>;
  stdout: WritableStream<Uint8Array>;
  read: () => string[];
  finish: () => void;
} {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const written: string[] = [];
  let close: (() => void) | undefined;

  const stdin = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      close = () => controller.close();
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
        .filter((line) => line.trim() !== ""),
    finish: () => close?.(),
  };
}

describe("craft acp", () => {
  const roots: string[] = [];
  let instance: Served | undefined;

  afterEach(() => {
    instance?.stop();
    instance = undefined;
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
   * @case A request and a notification cross the bridge in both directions, unchanged
   * @preconditions A stub instance speaking the protocol, and an editor writing an initialize, a session/new and a prompt
   * @expectedResult The prompt reaches the instance as written and the agent's own notification and response reach the editor, so the bridge is a pipe rather than a participant
   */
  test("forwards a request and a notification both ways", async () => {
    instance = serve();
    const home = emptyHome();
    const editor = editorSide([
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: { cwd: "/work", mcpServers: [] },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId: "session-1",
          prompt: [{ type: "text", text: "ping" }],
        },
      }),
    ]);

    const running = acpCommand({
      url: instance.url,
      cwd: settings(""),
      home,
      env: {},
      stdin: editor.stdin,
      stdout: editor.stdout,
    });
    // Give the three messages their round trips, then close the editor's
    // side, which is what closing an editor tab looks like from here.
    await waitFor(() => editor.read().length >= 4);
    editor.finish();
    const result = await running;

    expect(result.code).toBe(0);
    expect(instance.prompts).toEqual(["ping"]);
    const seen = editor.read().map(
      (line) =>
        JSON.parse(line) as {
          id?: number;
          method?: string;
          result?: { stopReason?: string };
        },
    );
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
    instance = serve();
    const cwd = settings(`
profile: company
profiles:
  company:
    url: ${instance.url}
    token: paste-me
    agent: zoe
`);
    const editor = editorSide([
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      }),
    ]);

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
   * @case An instance that is not there is reported as such rather than hanging
   * @preconditions A url nothing is listening on
   * @expectedResult A non-zero exit naming the address and where the address came from, which is the first thing to check
   */
  test("an unreachable instance names the address and its source", async () => {
    const editor = editorSide([
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      }),
    ]);
    const result = await acpCommand({
      url: "http://127.0.0.1:1",
      cwd: settings(""),
      home: emptyHome(),
      env: {},
      stdin: editor.stdin,
      stdout: editor.stdout,
    });
    // The family's code for an address nothing answered on, so one script
    // reads a failed `exec` and a failed `acp` the same way.
    expect(result.code).toBe(3);
    expect(result.error).toContain("http://127.0.0.1:1/acp");
    expect(result.error).toContain("flag");
  });

  /**
   * @case The bridge exits when the instance goes away, even though the editor still holds stdin open
   * @preconditions A connected bridge whose instance is stopped, with the editor's stdin deliberately never closed, which is what an open editor window looks like from here
   * @expectedResult `acpCommand` settles. Under `Promise.all` it did not: the instance-to-editor direction ended and the editor-to-instance direction stayed pending on an stdin nobody was going to close, so `craft acp` stayed alive with nothing behind it
   */
  test("the instance closing ends the bridge while stdin stays open", async () => {
    instance = serve();
    const editor = editorSide([
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      }),
    ]);

    const running = acpCommand({
      url: instance.url,
      cwd: settings(""),
      home: emptyHome(),
      env: {},
      stdin: editor.stdin,
      stdout: editor.stdout,
    });
    // Connected: the reply came back, so both directions are live.
    await waitFor(() => editor.read().length >= 1);

    instance.stop();
    // Note what is NOT done here: editor.finish() is never called, so the
    // editor side of the pipe stays open exactly as a real one would.
    const result = await settledWithin(running, 5_000);

    expect(result).not.toBe(TIMED_OUT);
  });

  /**
   * @case The editor closing ends the bridge cleanly
   * @preconditions A connected bridge whose editor closes its side first
   * @expectedResult Exit 0 and no error. This is the ordinary end of a session, and the sibling direction being cancelled by it must not turn a clean close into a reported failure
   */
  test("the editor closing ends the bridge cleanly", async () => {
    instance = serve();
    const editor = editorSide([
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      }),
    ]);

    const running = acpCommand({
      url: instance.url,
      cwd: settings(""),
      home: emptyHome(),
      env: {},
      stdin: editor.stdin,
      stdout: editor.stdout,
    });
    await waitFor(() => editor.read().length >= 1);
    editor.finish();

    const result = await settledWithin(running, 5_000);
    expect(result).not.toBe(TIMED_OUT);
    expect(result).toEqual({ code: 0 });
  });

  /**
   * @case A real failure is reported as itself, not as the cancellation it caused
   * @preconditions A bridge pointed at an address nothing answers on, so one direction fails for a real reason and the other is aborted by this command in response
   * @expectedResult The message names the address and where it came from. The sibling's abort is an artefact of handling the failure, and reporting it instead would name the cancellation rather than the disconnect that prompted it
   */
  test("the reported error is the real one, not the sibling's abort", async () => {
    const editor = editorSide([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    ]);

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
    expect(settled.code).toBe(3);
    expect(settled.error).toContain("http://127.0.0.1:1/acp");
    expect(settled.error).not.toContain("abort");
    expect(settled.error).not.toContain("Abort");
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
