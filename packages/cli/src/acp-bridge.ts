/**
 * The relay behind `craft acp`: a pipe that re-establishes itself.
 *
 * Every message crosses it verbatim while the instance is up. When the
 * instance goes away (a restart under an open editor window is the usual
 * case), the editor's side stays open and the relay reconnects: a fresh
 * transport, the editor's own `initialize` replayed, and `session/resume`
 * for every conversation the editor had attached, so the editor keeps
 * talking to the same conversation without knowing anything happened.
 *
 * The protocol does not replay what was in flight when the transport
 * died, so the relay answers for it: a `session/prompt` that was waiting
 * gets `cancelled` (the protocol's own word for a turn that ended with no
 * reply), any other request gets an error naming the outage, and an
 * answer the editor later gives to a request the dead connection made is
 * dropped rather than posted to a connection that never asked. Everything
 * the editor sends during the outage is queued and delivered once the
 * handshake on the new transport has completed.
 *
 * The first connection is different: an address nothing answers on is a
 * configuration mistake, and the relay reports it rather than waiting for
 * it to come right. Reconnection is for a connection that once worked.
 */

import { messageOf } from "./util.js";

/** A JSON-RPC 2.0 message as it crosses the relay. */
export interface RpcMessage {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { code: number; message: string; data?: unknown };
}

/** One side of the relay: what it reads from and writes to. */
export interface BridgeTransport {
  readonly readable: ReadableStream<RpcMessage>;
  readonly writable: WritableStream<RpcMessage>;
}

export interface BridgeOptions {
  /** The editor's side, open for the life of the relay. */
  readonly editor: BridgeTransport;
  /**
   * A fresh transport to the instance. Called once at the start and once
   * per reconnection attempt; a transport is never reused after it fails.
   */
  readonly connect: () => BridgeTransport;
  /** Where the instance is, for the diagnostics. */
  readonly target: string;
  /** One diagnostic line, to standard error in the command. */
  readonly log: (line: string) => void;
  /**
   * Delays between reconnection attempts, in milliseconds. The last one
   * repeats until the editor closes.
   */
  readonly delays?: readonly number[];
  /** How long one handshake may take before the attempt is abandoned. */
  readonly handshakeTimeoutMs?: number;
}

/** How the relay ended. */
export type BridgeOutcome =
  | { readonly kind: "editor-closed" }
  | { readonly kind: "editor-error"; readonly error: unknown }
  | { readonly kind: "unreachable"; readonly error: unknown };

/** Doubling from a quarter second to five, which then repeats. */
const DEFAULT_DELAYS_MS: readonly number[] = [
  250, 500, 1_000, 2_000, 4_000, 5_000,
];

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/** Attempts between "still trying" lines, so an outage does not fill stderr. */
const ATTEMPTS_PER_LOG = 12;

/**
 * JSON-RPC's implementation-defined server error range starts here. The
 * protocol defines no code for a lost connection, and this is the one the
 * SDK's own `RequestError` family leaves free.
 */
const CONNECTION_LOST = -32000;

/** The prefix on ids of requests the relay makes for itself. */
const OWN_ID_PREFIX = "craft-acp:";

/** How many editor messages the relay holds while no transport can take them. */
const MAX_QUEUED = 200;

/**
 * The methods the relay must understand to restore a connection after an
 * outage. Mirrors `@routecraft/ai`'s ACP mount; the CLI does not depend on
 * that package (see `ACP_AGENT_HEADER`'s own note in `acp.ts`), so this is
 * duplicated rather than shared, and is spelled once here rather than
 * scattered through the module.
 */
const METHOD = {
  initialize: "initialize",
  newSession: "session/new",
  loadSession: "session/load",
  resumeSession: "session/resume",
  closeSession: "session/close",
  prompt: "session/prompt",
} as const;

type State = "connected" | "connecting" | "lost" | "done";

interface EditorRequest {
  readonly id: string | number;
  readonly method: string;
  readonly sessionId?: string;
  readonly cwd?: string;
}

interface OwnRequest {
  resolve(message: RpcMessage): void;
  reject(error: unknown): void;
}

/** Run the relay until the editor closes its side, or the first connection fails. */
export function runBridge(options: BridgeOptions): Promise<BridgeOutcome> {
  return new Bridge(options).run();
}

class Bridge {
  private state: State = "connected";
  private everConnected = false;
  private writer: WritableStreamDefaultWriter<RpcMessage> | undefined;
  private readonly editorWriter: WritableStreamDefaultWriter<RpcMessage>;
  private editorChain: Promise<void> = Promise.resolve();

  /** The editor's `initialize`, replayed on every reconnection. */
  private initialize: RpcMessage | undefined;
  /** Conversations the editor has attached, with the cwd it named. */
  private readonly sessions = new Map<string, string>();
  /** Editor requests the instance has not answered. */
  private readonly editorRequests = new Map<string, EditorRequest>();
  /** Instance requests the editor has not answered. */
  private readonly instanceRequests = new Set<string>();
  /** The relay's own handshake requests. */
  private readonly ownRequests = new Map<string, OwnRequest>();
  /** What the editor sent while no transport could take it. */
  private readonly queue: RpcMessage[] = [];
  private ownSequence = 0;
  private reconnecting = false;
  /**
   * True while {@link flush} is draining the outage queue. A message that
   * arrives from the editor during the drain must wait behind whatever is
   * still queued ahead of it, not overtake it by going straight to the
   * instance just because the state has already turned "connected".
   */
  private flushing = false;
  /**
   * Bumped on every `attach()` and on every connecting-phase failure. A
   * transport's read loop tags itself with the value current when it
   * started; if that value has moved on by the time the loop ends, this
   * transport has already been superseded and its failure must not be
   * acted on against whatever replaced it.
   */
  private generation = 0;
  /** The last reason a connecting-phase attempt failed, for the periodic line. */
  private lastFailureReason: string | undefined;

  private readonly delays: readonly number[];
  private readonly handshakeTimeoutMs: number;
  private readonly stopped = new AbortController();
  private settle!: (outcome: BridgeOutcome) => void;
  private readonly settled = new Promise<BridgeOutcome>((resolve) => {
    this.settle = resolve;
  });

  constructor(private readonly options: BridgeOptions) {
    this.editorWriter = options.editor.writable.getWriter();
    this.delays = options.delays ?? DEFAULT_DELAYS_MS;
    this.handshakeTimeoutMs =
      options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  }

  async run(): Promise<BridgeOutcome> {
    // A synchronous throw here (a malformed url, a transport already
    // locked) is the same "address to check" as a connection that never
    // answers, so it goes through the same `lost()` path rather than
    // rejecting this promise and leaving `acpCommand` without its
    // documented unreachable result.
    try {
      this.attach(this.options.connect());
    } catch (error: unknown) {
      this.lost(error);
      return this.settled;
    }
    void this.readEditor();
    return this.settled;
  }

  // ------------------------------------------------------------ the editor

  private async readEditor(): Promise<void> {
    try {
      await readEach(this.options.editor.readable, (message) =>
        this.fromEditor(message),
      );
    } catch (error: unknown) {
      // Reported once, by the caller building the command's result from
      // the `editor-error` outcome; a line here too would say the same
      // thing twice for a failure the process is exiting on regardless.
      this.editorClosed(true, error);
      return;
    }
    this.editorClosed(false);
  }

  private async fromEditor(message: RpcMessage): Promise<void> {
    if (this.state === "done") return;

    if (isResponse(message)) {
      // The editor answering the instance. An answer to a request a dead
      // connection made has nowhere to go: the connection that asked is
      // gone, and posting it to the new one would be posting an id it
      // never issued.
      const key = keyOf(message.id);
      if (!this.instanceRequests.has(key)) return;
      this.instanceRequests.delete(key);
      await this.toInstance(message);
      return;
    }

    if (message.method === METHOD.initialize && isRequest(message)) {
      this.initialize = message;
    }
    if (isRequest(message)) {
      const params = paramsOf(message);
      this.editorRequests.set(keyOf(message.id), {
        id: message.id,
        method: message.method,
        ...(typeof params["sessionId"] === "string"
          ? { sessionId: params["sessionId"] }
          : {}),
        ...(typeof params["cwd"] === "string" ? { cwd: params["cwd"] } : {}),
      });
      if (message.method === METHOD.closeSession) {
        const sessionId = params["sessionId"];
        if (typeof sessionId === "string") this.sessions.delete(sessionId);
      }
    }

    if (this.state !== "connected" || this.flushing) {
      if (this.queue.length >= MAX_QUEUED) {
        if (isRequest(message)) {
          this.editorRequests.delete(keyOf(message.id));
          this.toEditor({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: CONNECTION_LOST,
              message: `Lost the connection to the instance; too many messages queued during the outage, "${message.method}" was dropped rather than queued.`,
            },
          });
        }
        return;
      }
      this.queue.push(message);
      return;
    }
    await this.toInstance(message);
  }

  /**
   * Write to the current transport.
   *
   * A write that fails never reached the instance, so the message goes
   * back to the front of the queue for the next transport, and its
   * `editorRequests` entry is left exactly as it was: {@link failInFlight}
   * is what decides, from queue membership, which requests get an outage
   * answer, and this message is unshifted back before {@link lost} runs so
   * it is judged still-queued rather than in flight. The one exception is
   * a request the read side already found the same loss for first: its
   * entry is gone by the time this catch runs, and it must not be queued
   * again on top of the answer it already got.
   */
  private async toInstance(message: RpcMessage): Promise<void> {
    const writer = this.writer;
    if (writer === undefined) {
      this.queue.unshift(message);
      return;
    }
    try {
      await writer.write(message);
    } catch (error: unknown) {
      const key = isRequest(message) ? keyOf(message.id) : undefined;
      const alreadyAnswered =
        key !== undefined && !this.editorRequests.has(key);
      if (!alreadyAnswered) this.queue.unshift(message);
      this.lost(error);
    }
  }

  /**
   * A failed write means the editor's output pipe is broken; its input
   * side can stay open regardless, so nothing else would ever notice.
   * Settling here is what ends the relay instead of it running on,
   * silently dropping everything meant for an editor that can no longer
   * hear it. Already-settled is a safe no-op the guard in `editorClosed`
   * handles, including the ordinary case where this write lost a race
   * with the writer's own clean close.
   */
  private toEditor(message: RpcMessage): void {
    this.editorChain = this.editorChain
      .then(() => this.editorWriter.write(message))
      .catch((error: unknown) => this.editorClosed(true, error));
  }

  /**
   * The editor's side ended: cleanly (its stream closed, `hadError`
   * false) or not (its stream broke, `hadError` true). Either way there
   * is nothing left to relay to, so the teardown is the same; only the
   * outcome the command reports differs. `hadError` carries that,
   * separately from `error` itself: a rejection can be `undefined` (a
   * bare `controller.error()` is valid), so the error's own value can
   * never be what tells a genuine failure apart from a clean close.
   */
  private editorClosed(hadError: boolean, error?: unknown): void {
    if (this.state === "done") return;
    this.state = "done";
    this.stopped.abort();
    for (const own of this.ownRequests.values()) {
      own.reject(new Error("the editor closed"));
    }
    this.ownRequests.clear();
    // Closing the transport's writable closes the transport, which ends
    // the readable the instance loop is reading, so both sides settle.
    void this.writer?.close().catch(() => undefined);
    void this.editorWriter.close().catch(() => undefined);
    this.settle(
      hadError ? { kind: "editor-error", error } : { kind: "editor-closed" },
    );
  }

  // ---------------------------------------------------------- the instance

  private attach(transport: BridgeTransport): void {
    this.generation += 1;
    const generation = this.generation;
    this.writer = transport.writable.getWriter();
    void this.readInstance(transport, generation);
  }

  private async readInstance(
    transport: BridgeTransport,
    generation: number,
  ): Promise<void> {
    let failure: unknown = new Error("the instance closed the connection");
    try {
      await readEach(transport.readable, (message) => {
        this.fromInstance(message, generation);
      });
    } catch (error: unknown) {
      failure = error;
    }
    // A transport that has already been superseded by a newer `attach()`
    // (this one lost the race, or was explicitly aborted by `lost()`) must
    // not report its own end as a fresh loss against whatever replaced it.
    if (this.state === "done" || generation !== this.generation) return;
    this.lost(failure);
  }

  private fromInstance(message: RpcMessage, generation: number): void {
    if (this.state === "done" || generation !== this.generation) return;
    this.everConnected = true;

    if (isResponse(message)) {
      const key = keyOf(message.id);
      const own = this.ownRequests.get(key);
      if (own !== undefined) {
        this.ownRequests.delete(key);
        own.resolve(message);
        return;
      }
      const request = this.editorRequests.get(key);
      this.editorRequests.delete(key);
      if (request !== undefined && message.error === undefined) {
        this.noteAttached(request, message);
      }
      this.toEditor(message);
      return;
    }

    if (isRequest(message)) {
      this.instanceRequests.add(keyOf(message.id));
    }
    this.toEditor(message);
  }

  /** A conversation the editor now holds, from the request that attached it. */
  private noteAttached(request: EditorRequest, response: RpcMessage): void {
    if (request.cwd === undefined) return;
    if (request.method === METHOD.newSession) {
      const result = response.result as { sessionId?: unknown } | undefined;
      if (typeof result?.sessionId === "string") {
        this.sessions.set(result.sessionId, request.cwd);
      }
      return;
    }
    if (
      (request.method === METHOD.loadSession ||
        request.method === METHOD.resumeSession) &&
      request.sessionId !== undefined
    ) {
      this.sessions.set(request.sessionId, request.cwd);
    }
  }

  /**
   * The current transport is gone.
   *
   * Before the first message ever arrived, that is an address nothing
   * answers on, reported as such. During a handshake, it is one failed
   * attempt and the reconnection loop takes the next. Otherwise it is an
   * outage: what was in flight is answered for, and the loop starts.
   */
  private lost(error: unknown): void {
    if (this.state === "done" || this.state === "lost") return;

    if (!this.everConnected) {
      this.state = "done";
      this.stopped.abort();
      void this.editorWriter.close().catch(() => undefined);
      this.settle({ kind: "unreachable", error });
      return;
    }

    // Bumping the generation here, not only in `attach()`, means a
    // transport whose read loop is still unwinding when a *different*
    // failure (a write, or a handshake timeout) calls `lost()` first is
    // marked stale immediately, before its own `readInstance` callback
    // can run and act on a connection that is no longer current.
    const wasConnecting = this.state === "connecting";
    this.generation += 1;
    this.state = "lost";
    void this.writer?.abort().catch(() => undefined);
    this.writer = undefined;
    for (const own of this.ownRequests.values()) own.reject(error);
    this.ownRequests.clear();
    if (wasConnecting) {
      this.lastFailureReason = messageOf(error);
      return;
    }

    this.lastFailureReason = undefined;
    this.options.log(
      `Lost the connection to ${this.options.target}: ${messageOf(error)}. Waiting for it to come back.`,
    );
    this.failInFlight();
    this.instanceRequests.clear();
    void this.reconnect();
  }

  /**
   * Answer for every editor request the dead transport never will: one it
   * had already sent, or was in the middle of sending, when it died. A
   * request still waiting in the outage queue was never handed to this
   * transport at all; it stays registered and is answered fresh when a
   * later transport actually sends it, so it is left alone here rather
   * than answered twice.
   */
  private failInFlight(): void {
    const stillQueued = new Set(
      this.queue.filter(isRequest).map((message) => keyOf(message.id)),
    );
    for (const [key, request] of this.editorRequests) {
      if (stillQueued.has(key)) continue;
      this.toEditor(
        request.method === METHOD.prompt
          ? {
              jsonrpc: "2.0",
              id: request.id,
              result: { stopReason: "cancelled" },
            }
          : {
              jsonrpc: "2.0",
              id: request.id,
              error: {
                code: CONNECTION_LOST,
                message: `Lost the connection to the instance while "${request.method}" was in flight; the request was not answered.`,
              },
            },
      );
      this.editorRequests.delete(key);
    }
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    const startedAt = Date.now();
    let attempt = 0;
    try {
      while (this.state === "lost") {
        await sleep(
          this.delays[Math.min(attempt, this.delays.length - 1)] ?? 0,
          this.stopped.signal,
        );
        if (this.state !== "lost") return;
        attempt += 1;
        if (attempt > 1 && attempt % ATTEMPTS_PER_LOG === 1) {
          this.options.log(
            `Still waiting for ${this.options.target} (attempt ${attempt}, ${elapsed(startedAt)})${this.lastFailureReason !== undefined ? `: ${this.lastFailureReason}` : ""}.`,
          );
        }
        this.state = "connecting";
        try {
          const transport = this.options.connect();
          this.attach(transport);
          await withTimeout(this.handshake(), this.handshakeTimeoutMs);
        } catch (error: unknown) {
          // Covers a `connect()`/`attach()` throw as well as a handshake
          // timeout; a transport failure surfaces through `readInstance`
          // instead and calls `lost()` itself, which this is a no-op
          // against once that has already moved the state on.
          this.lost(error);
          continue;
        }
        if (this.state !== "connecting") continue;
        this.state = "connected";
        this.options.log(
          `Reconnected to ${this.options.target} after ${attempt} attempt${attempt === 1 ? "" : "s"} (${elapsed(startedAt)}).`,
        );
        await this.flush();
      }
    } finally {
      this.reconnecting = false;
    }
  }

  /**
   * What a fresh transport needs before the editor's messages may cross
   * it: the editor's own `initialize`, then every conversation it had
   * attached, resumed rather than loaded so nothing is replayed onto a
   * screen that already shows it.
   */
  private async handshake(): Promise<void> {
    if (this.initialize === undefined) {
      throw new Error("the editor never initialized");
    }
    const initialized = await this.own(
      METHOD.initialize,
      this.initialize.params,
    );
    if (initialized.error !== undefined) {
      throw new Error(`initialize was refused: ${initialized.error.message}`);
    }
    for (const [sessionId, cwd] of [...this.sessions]) {
      const resumed = await this.own(METHOD.resumeSession, {
        sessionId,
        cwd,
        mcpServers: [],
      });
      if (resumed.error !== undefined) {
        // The instance came back without it: a store that does not
        // outlive the process. Nothing to attach; the editor's next
        // message about it is refused by the instance, by name.
        this.sessions.delete(sessionId);
        this.options.log(
          `Conversation ${sessionId} is not on ${this.options.target} any more (${resumed.error.message}). Start a new one from the editor.`,
        );
      }
    }
  }

  private own(method: string, params: unknown): Promise<RpcMessage> {
    const writer = this.writer;
    if (writer === undefined) {
      return Promise.reject(new Error("no transport"));
    }
    this.ownSequence += 1;
    const id = `${OWN_ID_PREFIX}${this.ownSequence}`;
    const response = new Promise<RpcMessage>((resolve, reject) => {
      this.ownRequests.set(keyOf(id), { resolve, reject });
    });
    // A transport that dies mid-write rejects the write and, through
    // `lost`, this response too; the caller sees the first and nobody
    // would otherwise see the second.
    response.catch(() => undefined);
    return writer
      .write({ jsonrpc: "2.0", id, method, params })
      .then(() => response);
  }

  /**
   * Deliver what the editor sent while no transport could take it, oldest
   * first. Writes straight to the transport rather than back through
   * {@link fromEditor}: each message was already registered when it was
   * first queued, and re-entering `fromEditor` would only requeue it,
   * since `flushing` holds every new arrival behind the drain.
   *
   * A response is the one shape dropped rather than replayed: it answers
   * an instance-initiated request, and `instanceRequests` is cleared on
   * every loss, so the new transport never made the request this would be
   * answering. Posting it anyway would be posting an id the new instance
   * never issued, the same case `fromEditor` itself already guards for a
   * response arriving live.
   */
  private async flush(): Promise<void> {
    this.flushing = true;
    try {
      while (this.queue.length > 0 && this.state === "connected") {
        const message = this.queue.shift() as RpcMessage;
        if (isResponse(message)) continue;
        await this.toInstance(message);
      }
    } finally {
      this.flushing = false;
    }
  }
}

// ------------------------------------------------------------------ helpers

/** Every message a stream yields until it closes; a failed stream throws. */
async function readEach(
  readable: ReadableStream<RpcMessage>,
  each: (message: RpcMessage) => void | Promise<void>,
): Promise<void> {
  const reader = readable.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      await each(value);
    }
  } finally {
    reader.releaseLock();
  }
}

function isRequest(
  message: RpcMessage,
): message is RpcMessage & { id: string | number; method: string } {
  return (
    typeof message.method === "string" &&
    message.id !== undefined &&
    message.id !== null
  );
}

function isResponse(
  message: RpcMessage,
): message is RpcMessage & { id: string | number } {
  return (
    message.method === undefined &&
    message.id !== undefined &&
    message.id !== null &&
    ("result" in message || "error" in message)
  );
}

/** The map key for a request or response id known not to be null. */
function keyOf(id: string | number): string {
  return `${typeof id}:${String(id)}`;
}

function paramsOf(message: RpcMessage): Record<string, unknown> {
  return message.params !== null && typeof message.params === "object"
    ? (message.params as Record<string, unknown>)
    : {};
}

function elapsed(since: number): string {
  return `${Math.round((Date.now() - since) / 1000)}s`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`the handshake took longer than ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
