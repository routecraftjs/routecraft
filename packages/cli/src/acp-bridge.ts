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
    this.attach(this.options.connect());
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
      this.options.log(
        `The editor's side of the pipe failed: ${describe(error)}`,
      );
    }
    this.editorClosed();
  }

  private async fromEditor(message: RpcMessage): Promise<void> {
    if (this.state === "done") return;

    if (isResponse(message)) {
      // The editor answering the instance. An answer to a request a dead
      // connection made has nowhere to go: the connection that asked is
      // gone, and posting it to the new one would be posting an id it
      // never issued.
      const key = idKey(message.id);
      if (key === undefined || !this.instanceRequests.has(key)) return;
      this.instanceRequests.delete(key);
      await this.toInstance(message);
      return;
    }

    if (message.method === "initialize" && isRequest(message)) {
      this.initialize = message;
    }
    if (isRequest(message)) {
      const params = paramsOf(message);
      this.editorRequests.set(idKey(message.id) as string, {
        id: message.id as string | number,
        method: message.method as string,
        ...(typeof params["sessionId"] === "string"
          ? { sessionId: params["sessionId"] }
          : {}),
        ...(typeof params["cwd"] === "string" ? { cwd: params["cwd"] } : {}),
      });
      if (message.method === "session/close") {
        const sessionId = params["sessionId"];
        if (typeof sessionId === "string") this.sessions.delete(sessionId);
      }
    }

    if (this.state !== "connected") {
      this.queue.push(message);
      return;
    }
    await this.toInstance(message);
  }

  /**
   * Write to the current transport.
   *
   * A write that fails never reached the instance, so the message goes
   * back to the front of the queue for the next transport rather than
   * being answered for as lost: only a request the instance may have
   * received is answered by {@link lost}, and this one was not.
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
      const key = idKey(message.id);
      if (key !== undefined && isRequest(message)) {
        this.editorRequests.delete(key);
      }
      this.queue.unshift(message);
      this.lost(error);
    }
  }

  private toEditor(message: RpcMessage): void {
    this.editorChain = this.editorChain
      .then(() => this.editorWriter.write(message))
      .catch(() => undefined);
  }

  private editorClosed(): void {
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
    this.settle({ kind: "editor-closed" });
  }

  // ---------------------------------------------------------- the instance

  private attach(transport: BridgeTransport): void {
    this.writer = transport.writable.getWriter();
    void this.readInstance(transport);
  }

  private async readInstance(transport: BridgeTransport): Promise<void> {
    let failure: unknown = new Error("the instance closed the connection");
    try {
      await readEach(transport.readable, (message) => {
        this.fromInstance(message);
      });
    } catch (error: unknown) {
      failure = error;
    }
    if (this.state === "done") return;
    this.lost(failure);
  }

  private fromInstance(message: RpcMessage): void {
    if (this.state === "done") return;
    this.everConnected = true;

    if (isResponse(message)) {
      const key = idKey(message.id);
      if (key === undefined) return;
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
      this.instanceRequests.add(idKey(message.id) as string);
    }
    this.toEditor(message);
  }

  /** A conversation the editor now holds, from the request that attached it. */
  private noteAttached(request: EditorRequest, response: RpcMessage): void {
    if (request.cwd === undefined) return;
    if (request.method === "session/new") {
      const result = response.result as { sessionId?: unknown } | undefined;
      if (typeof result?.sessionId === "string") {
        this.sessions.set(result.sessionId, request.cwd);
      }
      return;
    }
    if (
      (request.method === "session/load" ||
        request.method === "session/resume") &&
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

    const wasConnecting = this.state === "connecting";
    this.state = "lost";
    this.writer = undefined;
    for (const own of this.ownRequests.values()) own.reject(error);
    this.ownRequests.clear();
    if (wasConnecting) return;

    this.options.log(
      `Lost the connection to ${this.options.target}: ${describe(error)}. Waiting for it to come back.`,
    );
    this.failInFlight();
    this.instanceRequests.clear();
    void this.reconnect();
  }

  /** Answer for every editor request the dead transport never will. */
  private failInFlight(): void {
    for (const request of this.editorRequests.values()) {
      this.toEditor(
        request.method === "session/prompt"
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
    }
    this.editorRequests.clear();
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
            `Still waiting for ${this.options.target} (attempt ${attempt}, ${elapsed(startedAt)}).`,
          );
        }
        this.state = "connecting";
        const transport = this.options.connect();
        this.attach(transport);
        try {
          await withTimeout(this.handshake(), this.handshakeTimeoutMs);
        } catch {
          // The transport's readable reports the same failure through
          // `lost`, which returns the state to "lost" for the next turn
          // of the loop. A timeout is the one failure only this side
          // sees, so the transport is torn down here for that case.
          if (this.state === "connecting") {
            this.state = "lost";
            void this.writer?.abort().catch(() => undefined);
            this.writer = undefined;
          }
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
    const initialized = await this.own("initialize", this.initialize.params);
    if (initialized.error !== undefined) {
      throw new Error(`initialize was refused: ${initialized.error.message}`);
    }
    for (const [sessionId, cwd] of [...this.sessions]) {
      const resumed = await this.own("session/resume", {
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
      this.ownRequests.set(idKey(id) as string, { resolve, reject });
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
   * Deliver what the editor sent while no transport could take it, through
   * the same door a live message takes, so a request is registered again
   * before it goes out and a stale answer is still dropped.
   */
  private async flush(): Promise<void> {
    while (this.queue.length > 0 && this.state === "connected") {
      const message = this.queue.shift() as RpcMessage;
      await this.fromEditor(message);
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

function isRequest(message: RpcMessage): boolean {
  return (
    typeof message.method === "string" &&
    message.id !== undefined &&
    message.id !== null
  );
}

function isResponse(message: RpcMessage): boolean {
  return (
    message.method === undefined &&
    message.id !== undefined &&
    ("result" in message || "error" in message)
  );
}

function idKey(id: RpcMessage["id"]): string | undefined {
  if (id === undefined || id === null) return undefined;
  return `${typeof id}:${String(id)}`;
}

function paramsOf(message: RpcMessage): Record<string, unknown> {
  return message.params !== null && typeof message.params === "object"
    ? (message.params as Record<string, unknown>)
    : {};
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
