/**
 * `runBridge`, the relay behind `craft acp`, driven directly against
 * synthetic transports.
 *
 * `acp.bun.test.ts` exercises the relay through a real protocol server and
 * real wall-clock delays; this file exercises the state machine itself, with
 * `delays` and `handshakeTimeoutMs` shrunk to milliseconds so the backoff
 * ladder, the handshake timeout, and the periodic "still waiting" line are
 * covered without a slow suite.
 */

import { describe, expect, test } from "bun:test";

import {
  runBridge,
  type BridgeTransport,
  type RpcMessage,
} from "../src/acp-bridge.js";

/** Attempts between "still trying" lines; mirrors the constant in acp-bridge.ts. */
const ATTEMPTS_PER_LOG = 12;

/**
 * One side of a synthetic transport, with a controller to drive its
 * readable. `onWrite` sees every message the bridge writes; it can `push`
 * a reply on the readable, or throw to make that one write itself fail
 * (as a real transport's write does when the connection is already gone).
 */
function transport(
  onWrite?: (message: RpcMessage, push: (message: RpcMessage) => void) => void,
): {
  transport: BridgeTransport;
  push: (message: RpcMessage) => void;
  fail: (error: unknown) => void;
  close: () => void;
  written: RpcMessage[];
} {
  const written: RpcMessage[] = [];
  let controller: ReadableStreamDefaultController<RpcMessage> | undefined;
  const readable = new ReadableStream<RpcMessage>({
    start(c) {
      controller = c;
    },
  });
  const writable = new WritableStream<RpcMessage>({
    write(message) {
      written.push(message);
      onWrite?.(message, (reply) => controller?.enqueue(reply));
    },
  });
  return {
    transport: { readable, writable },
    push: (message) => controller?.enqueue(message),
    fail: (error) => controller?.error(error),
    close: () => controller?.close(),
    written,
  };
}

/** Answers every `initialize` it is written with a result for the same id. */
function respondingTransport(): ReturnType<typeof transport> {
  return transport((message, push) => {
    if (message.method === "initialize") {
      push({
        jsonrpc: "2.0",
        id: message.id ?? null,
        result: { protocolVersion: 1 },
      });
    }
  });
}

/** Never answers anything; a handshake against it only ever times out. */
function deadTransport(): ReturnType<typeof transport> {
  return transport();
}

/** Wait for a condition, bounded, so a failure reports rather than hangs. */
async function waitFor(condition: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(condition()).toBe(true);
}

describe("runBridge", () => {
  /**
   * @case A reconnection attempt whose handshake never answers is abandoned at the timeout rather than hanging forever, the loop keeps retrying, throttles its "still waiting" line to every twelfth attempt, and eventually reconnects once an attempt lands on a live instance
   * @preconditions A live first connection that is then lost, a handshake timeout far shorter than the default, and twelve reconnection attempts in a row landing on a transport that never answers before the thirteenth lands on one that does
   * @expectedResult The loss is logged once, no more than one "still waiting" line appears despite twelve failed attempts, that line names the timeout as the reason, and the relay reports reconnection on the attempt that finally answered, all without any real waiting
   */
  test("a handshake timeout is retried, throttled, and eventually reconnects", async () => {
    const editor = transport();
    const first = respondingTransport();
    const live = respondingTransport();
    let calls = 0;
    const lines: string[] = [];

    const outcome = runBridge({
      editor: editor.transport,
      connect: () => {
        calls += 1;
        if (calls === 1) return first.transport;
        if (calls <= 1 + ATTEMPTS_PER_LOG) return deadTransport().transport;
        return live.transport;
      },
      target: "test://instance",
      log: (line) => lines.push(line),
      delays: [0],
      handshakeTimeoutMs: 5,
    });

    editor.push({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor(() => editor.written.some((m) => m.id === 1));

    first.fail(new Error("the instance restarted"));
    await waitFor(() =>
      lines.some((line) => line.startsWith("Lost the connection")),
    );

    await waitFor(() => calls === 1 + ATTEMPTS_PER_LOG + 1, 10_000);
    await waitFor(() =>
      lines.some((line) => line.startsWith(`Reconnected to test://instance`)),
    );

    editor.close();
    expect(await outcome).toEqual({ kind: "editor-closed" });

    expect(
      lines.filter((line) => line.startsWith("Lost the connection")),
    ).toHaveLength(1);
    const stillWaiting = lines.filter((line) =>
      line.startsWith("Still waiting"),
    );
    expect(stillWaiting).toHaveLength(1);
    expect(stillWaiting[0]).toContain("attempt 13");
    expect(stillWaiting[0]).toContain("handshake");
    expect(
      lines.some((line) =>
        line.startsWith(
          `Reconnected to test://instance after ${1 + ATTEMPTS_PER_LOG} attempts`,
        ),
      ),
    ).toBe(true);
  }, 15_000);

  /**
   * @case The very first connection throwing synchronously is reported as unreachable, the same as one that never answers
   * @preconditions A `connect` that throws instead of returning a transport, on the first call `run()` ever makes
   * @expectedResult The bridge settles with `unreachable` and the thrown error; it does not leave `run()`'s promise rejected, which `acpCommand` has nothing to catch
   */
  test("a synchronous throw on the first connection reports unreachable", async () => {
    const editor = transport();
    const failure = new Error("bad url");

    const outcome = await runBridge({
      editor: editor.transport,
      connect: () => {
        throw failure;
      },
      target: "test://instance",
      log: () => undefined,
    });

    expect(outcome).toEqual({ kind: "unreachable", error: failure });
  });

  /**
   * @case A reconnection attempt whose `connect` or transport setup throws synchronously is treated as one failed attempt, the same as a handshake timeout, rather than crashing the reconnect loop
   * @preconditions A live first connection that is lost, then one reconnection attempt whose `connect` throws before the next attempt lands on a live transport
   * @expectedResult The loop survives the throw and reconnects on the next attempt
   */
  test("a synchronous throw during reconnection is one failed attempt, not a crash", async () => {
    const editor = transport();
    const first = respondingTransport();
    const live = respondingTransport();
    let calls = 0;
    const lines: string[] = [];

    const outcome = runBridge({
      editor: editor.transport,
      connect: () => {
        calls += 1;
        if (calls === 1) return first.transport;
        if (calls === 2) throw new Error("connect refused");
        return live.transport;
      },
      target: "test://instance",
      log: (line) => lines.push(line),
      delays: [0],
    });

    editor.push({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor(() => editor.written.some((m) => m.id === 1));

    first.fail(new Error("the instance restarted"));
    await waitFor(() =>
      lines.some((line) => line.startsWith("Reconnected to")),
    );
    expect(calls).toBe(3);

    editor.close();
    expect(await outcome).toEqual({ kind: "editor-closed" });
  });

  /**
   * @case The editor's own pipe erroring is reported distinctly from the editor closing cleanly
   * @preconditions A connected bridge whose editor readable errors rather than reaching EOF
   * @expectedResult The outcome is `editor-error` carrying that error, not `editor-closed`; `acpCommand` needs the distinction to avoid calling a broken pipe a successful run
   */
  test("the editor's pipe erroring reports editor-error, not editor-closed", async () => {
    const editor = transport();
    const instance = respondingTransport();
    const failure = new Error("stdin broke");

    const outcome = runBridge({
      editor: editor.transport,
      connect: () => instance.transport,
      target: "test://instance",
      log: () => undefined,
    });

    editor.fail(failure);

    expect(await outcome).toEqual({ kind: "editor-error", error: failure });
  });

  /**
   * @case A request still waiting in the outage queue when a second failure interrupts the reconnect is not answered twice: once now for the outage, and again for real once it is actually delivered
   * @preconditions Two requests queued during an outage; the reconnection that follows delivers the first successfully, then fails writing the second while the third is still waiting behind it in the queue; the next reconnection after that delivers both for real
   * @expectedResult The request still in the queue when the second failure hits gets no outage answer at all, only the one real answer once it is actually sent; nothing the editor sees is answered more than once
   */
  test("a request still queued when a second failure hits is not answered twice", async () => {
    const editor = transport();
    const first = respondingTransport();
    const flaky = transport((message, push) => {
      if (message.method === "initialize") {
        push({ jsonrpc: "2.0", id: message.id ?? null, result: {} });
        return;
      }
      if (message.id === 2) {
        throw new Error("dropped id 2");
      }
    });
    const revived = respondingTransport();
    let calls = 0;
    const lines: string[] = [];

    const outcome = runBridge({
      editor: editor.transport,
      connect: () => {
        calls += 1;
        if (calls === 1) return first.transport;
        if (calls === 2) return flaky.transport;
        return revived.transport;
      },
      target: "test://instance",
      log: (line) => lines.push(line),
      delays: [0],
    });

    editor.push({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor(() => editor.written.some((m) => m.id === 1));

    first.fail(new Error("the instance restarted"));
    await waitFor(() =>
      lines.some((line) => line.startsWith("Lost the connection")),
    );
    // Queued during the outage, in order: id 2 will fail to write on the
    // next transport, id 3 is still behind it in the queue when that
    // happens.
    editor.push({ jsonrpc: "2.0", id: 2, method: "custom/a", params: {} });
    editor.push({ jsonrpc: "2.0", id: 3, method: "custom/b", params: {} });

    // The flaky transport answers with a second "Lost the connection" once
    // id 2's write fails; wait for that, then for both to actually reach
    // `revived` on the next reconnection before answering them for real.
    await waitFor(
      () =>
        lines.filter((line) => line.startsWith("Lost the connection"))
          .length === 2,
    );
    await waitFor(
      () =>
        revived.written.some((m) => m.id === 2) &&
        revived.written.some((m) => m.id === 3),
    );
    revived.push({ jsonrpc: "2.0", id: 2, result: { done: true } });
    revived.push({ jsonrpc: "2.0", id: 3, result: { done: true } });
    await waitFor(() => editor.written.some((m) => m.id === 3));

    editor.close();
    await outcome;

    const answersFor2 = editor.written.filter((m) => m.id === 2);
    const answersFor3 = editor.written.filter((m) => m.id === 3);
    expect(answersFor2).toHaveLength(1);
    expect(answersFor2[0]?.result).toEqual({ done: true });
    expect(answersFor3).toHaveLength(1);
    expect(answersFor3[0]?.result).toEqual({ done: true });
  }, 10_000);
});
