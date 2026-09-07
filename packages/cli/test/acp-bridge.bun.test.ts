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

/** One side of a synthetic transport, with a controller to drive its readable. */
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
});
