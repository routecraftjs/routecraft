/**
 * One connection's half of the mount: the protocol handlers, and the
 * surface the routes reach back through.
 *
 * A connection belongs to one caller. Every session it can address is one
 * the caller owns, and the ownership filter that decides that lives in the
 * session runtime rather than here, so this file cannot widen it.
 */

import { randomUUID } from "node:crypto";
import type {
  AgentApp,
  AgentContext,
  ClientCapabilities,
  ContentBlock,
  InitializeRequest,
  InitializeResponse,
  ListSessionsResponse,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionInfo,
  SessionModeState,
  SessionUpdate,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  StopReason,
} from "@agentclientprotocol/sdk";
import { rcCodeOf, type Principal } from "@routecraft/routecraft";
import { version as PACKAGE_VERSION } from "../../package.json";
import type { AgentSessionSummary } from "../agent/session/types.ts";
import { registerSurface } from "../surface/index.ts";
import type {
  AgentSurfaceConnection,
  AgentSurfaceRef,
} from "../surface/index.ts";
import {
  CONFIG_AGENT,
  configOptionsFor,
  decideConfigOption,
  modesFor,
  type ConfigOptionState,
} from "./config-options.ts";
import { replayUpdates } from "./replay.ts";
import { AcpRuntime } from "./runtime.ts";
import type { AcpPluginOptions } from "./types.ts";

/** JSON-RPC invalid params, which is how this mount refuses a bad request. */
const INVALID_PARAMS = -32602;

/**
 * The slice of the SDK a connection needs at runtime.
 *
 * Injected rather than imported, because the SDK is an optional peer: the
 * mount loads it once and hands the pieces down, so this module stays
 * importable by anything that only wants the types.
 */
export interface AcpRuntimeSdk {
  readonly RequestError: typeof import("@agentclientprotocol/sdk").RequestError;
}

/**
 * What a client is told when a session is missing, or is not theirs.
 *
 * One message for both, deliberately. Two different answers would make
 * `session/load` an oracle for which session ids exist, and ids are cheap
 * to guess.
 */
const NO_SUCH_SESSION = "No such session.";

/**
 * One caller's connection.
 *
 * Created when the mount admits an `initialize`, retired when the
 * connection closes. It holds the caller's principal, which is what every
 * session read and every turn runs under.
 */
export class AcpConnection implements AgentSurfaceConnection {
  readonly kind = "acp" as const;
  /** Our own id, which is what a turn's surface header names. */
  readonly id = randomUUID();
  /** Set once the client has initialized. */
  private capabilities: ClientCapabilities | undefined;
  /** What the editor calls itself, from its initialize. */
  private clientName: string | undefined;
  /**
   * The ACP sessions this connection has taken hold of. Membership only:
   * which persona each belongs to is read from the record per operation,
   * because a conversation is named by its id alone and two connections
   * can hold one. A persona chosen in one window must not leave the other
   * dispatching to the persona it saw at attach.
   */
  private readonly attachedSessions = new Set<string>();
  private client: AgentContext | undefined;
  private closedHandler: (() => void) | undefined;
  private retire: (() => void) | undefined;

  constructor(
    private readonly runtime: AcpRuntime,
    private readonly options: AcpPluginOptions,
    /** The caller, as the mount's validator resolved them. */
    readonly principal: Principal | undefined,
    private readonly sdk: AcpRuntimeSdk,
    /**
     * The agent this connection asked for, when it named one. Every
     * conversation it opens talks to that persona; a connection that named
     * nothing gets the mount's own default.
     */
    private readonly requestedAgent: string | undefined,
  ) {}

  /** A refusal the connection layer turns into a JSON-RPC error. */
  private refuse(message: string): Error {
    return new this.sdk.RequestError(INVALID_PARAMS, message);
  }

  /** Whose sessions this connection may see. */
  get scope(): ReturnType<typeof AcpRuntime.scopeFor> {
    return AcpRuntime.scopeFor(this.principal);
  }

  // ---------------------------------------------------------------- surface

  supports(method: string): boolean {
    const capabilities = this.capabilities;
    if (capabilities === undefined) return false;
    switch (method) {
      case "fs/read_text_file":
        return capabilities.fs?.readTextFile === true;
      case "fs/write_text_file":
        return capabilities.fs?.writeTextFile === true;
      case "terminal/create":
      case "terminal/output":
      case "terminal/release":
      case "terminal/wait_for_exit":
      case "terminal/kill":
        return capabilities.terminal === true;
      case "elicitation/create":
        return (
          capabilities.elicitation !== undefined &&
          capabilities.elicitation !== null
        );
      // Asking a person to approve a tool call is the one client method
      // every conforming client serves; the protocol gates it behind no
      // capability, so neither do we.
      case "session/request_permission":
        return true;
      default:
        return false;
    }
  }

  capabilityFor(method: string): string {
    if (method.startsWith("fs/read")) return "fs.readTextFile";
    if (method.startsWith("fs/write")) return "fs.writeTextFile";
    if (method.startsWith("terminal/")) return "terminal";
    if (method.startsWith("elicitation/")) return "elicitation";
    return method;
  }

  async request(
    _session: string,
    method: string,
    params: unknown,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const client = this.client;
    if (client === undefined) throw new Error("The connection is not open.");
    // Cooperative: aborting sends `$/cancel_request` and the promise is
    // still settled by whatever the client eventually answers.
    return client.request<unknown, unknown>(
      method,
      params,
      signal === undefined ? undefined : { cancellationSignal: signal },
    );
  }

  async notify(session: string, update: unknown): Promise<void> {
    const client = this.client;
    if (client === undefined) throw new Error("The connection is not open.");
    await client.notify("session/update", {
      sessionId: session,
      update: update as SessionUpdate,
    });
  }

  // ------------------------------------------------------------- lifecycle

  /** Called once the SDK has opened the connection and given us its context. */
  open(client: AgentContext, closed: Promise<void>): void {
    this.client = client;
    this.retire = registerSurface(this.runtime.context, this.id, this);
    this.runtime.context.emit("plugin:acp:connection:opened", {
      connectionId: this.id,
      ...(this.principal !== undefined
        ? { subject: this.principal.subject }
        : {}),
      ...(this.clientName !== undefined ? { clientName: this.clientName } : {}),
    });
    // Retire on close however the transport ended, including a fault that
    // rejects rather than resolves: an unhandled rejection here would take
    // down an instance because one editor's socket broke.
    closed.finally(() => this.close()).catch(() => undefined);
  }

  /** Retire the surface. A turn still running finds it gone and says so. */
  close(): void {
    if (this.retire === undefined) return;
    this.retire();
    this.retire = undefined;
    this.client = undefined;
    this.runtime.context.emit("plugin:acp:connection:closed", {
      connectionId: this.id,
    });
    const closed = this.closedHandler;
    this.closedHandler = undefined;
    closed?.();
  }

  /**
   * Tell the mount when this connection goes.
   *
   * The mount keys its table by the SDK's connection id, which this object
   * does not carry, so the mount hands in the removal rather than deriving
   * it. Without this an editor that is killed rather than closed cleanly
   * leaves a record for the life of the process, and an instance serving
   * editors reconnects all day.
   */
  onClosed(handler: () => void): void {
    this.closedHandler = handler;
  }

  /** Announce a conversation this connection took hold of. */
  private attached(
    sessionId: string,
    agentName: string,
    how: "new" | "load" | "resume",
  ): void {
    this.attachedSessions.add(sessionId);
    this.runtime.context.emit("plugin:acp:session:attached", {
      connectionId: this.id,
      sessionId,
      agentName,
      how,
    });
  }

  // -------------------------------------------------------------- handlers

  initialize(params: InitializeRequest): InitializeResponse {
    this.capabilities = params.clientCapabilities;
    this.clientName = params.clientInfo?.name;
    // An app that sets this is white-labelling, so `title` is never
    // back-filled: "Routecraft" appearing beside somebody's own name
    // because they set two fields of three is the outcome the option
    // exists to avoid. `name` and `version` are required by the protocol
    // and cannot be absent, so those two alone fall back.
    const info = this.options.agentInfo;
    return {
      protocolVersion: 1,
      agentInfo:
        info === undefined
          ? DEFAULT_AGENT_INFO
          : {
              name: info.name ?? DEFAULT_AGENT_INFO.name,
              version: info.version ?? DEFAULT_AGENT_INFO.version,
              ...(info.title !== undefined ? { title: info.title } : {}),
            },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false,
        },
        sessionCapabilities: { list: {}, resume: {}, close: {} },
      },
      // Empty, and that is conforming: the mount refuses an
      // unauthenticated request before the SDK ever sees it, so there is
      // no authentication for the client to perform through the protocol.
      // A token in the profile is what authenticates.
      authMethods: [],
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const agent = this.agentForNewSession();
    if (params.mcpServers.length > 0) {
      // Logged and ignored: a remote instance must not spawn what an
      // editor names. Recorded as a requirement rather than a refusal.
      this.runtime.context.logger.info(
        { count: params.mcpServers.length },
        "ACP client declared MCP servers; this mount does not connect them",
      );
    }
    const sessionId = randomUUID();
    await this.runtime.sessions().open(sessionId, agent, {
      owner: this.principal?.subject ?? null,
      ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
    });
    this.attached(sessionId, agent, "new");
    const state = await this.stateFor(sessionId, agent);
    return {
      sessionId,
      configOptions: configOptionsFor(state),
      ...withModes(state),
    };
  }

  async loadSession(sessionId: string): Promise<LoadSessionResponse> {
    const agent = await this.resolveAgent(sessionId);
    this.attached(sessionId, agent, "load");
    const record = await this.runtime.sessions().store.load(sessionId);
    // Replayed before the response returns, which is what the SDK's own
    // client documents the reconnect path as expecting.
    for (const update of replayUpdates(record?.messages ?? [])) {
      await this.notify(sessionId, update);
    }
    const state = await this.stateFor(sessionId, agent);
    return { configOptions: configOptionsFor(state), ...withModes(state) };
  }

  async resumeSession(sessionId: string): Promise<ResumeSessionResponse> {
    const agent = await this.resolveAgent(sessionId);
    this.attached(sessionId, agent, "resume");
    const state = await this.stateFor(sessionId, agent);
    return { configOptions: configOptionsFor(state), ...withModes(state) };
  }

  /**
   * Drop the connection's hold on a session. The conversation itself
   * outlives every connection and nothing is deleted.
   */
  closeSession(sessionId: string): void {
    this.attachedSessions.delete(sessionId);
  }

  async listSessions(
    cwd: string | null | undefined,
    cursor: string | null | undefined,
  ): Promise<ListSessionsResponse> {
    const page = await this.runtime.sessions().summaries({
      scope: this.scope,
      ...(cwd != null ? { cwd } : {}),
      ...(cursor != null ? { after: cursor } : {}),
    });
    return {
      sessions: page.items.map(toSessionInfo),
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const agent = await this.resolveAgent(params.sessionId);
    const message = promptText(params.prompt, (reason) => this.refuse(reason));
    const key = params.sessionId;
    const surface: AgentSurfaceRef = {
      kind: "acp",
      session: params.sessionId,
      connection: this.id,
    };
    // The first prompt names the conversation, so a listing has something
    // to show. Later prompts leave the title alone: renaming a session on
    // every message would make the listing unreadable.
    await this.runtime.sessions().open(key, agent, {
      owner: this.principal?.subject ?? null,
      title: titleFrom(message),
    });
    const result = await this.runtime.runTurn(
      key,
      agent,
      message,
      this.principal,
      surface,
      (update) => this.notify(params.sessionId, update),
    );
    return { stopReason: stopReasonFor(result.session?.status) };
  }

  /**
   * Stop whatever the session is doing.
   *
   * A notification, so there is nothing to answer. The in-flight
   * `session/prompt` returns `cancelled`, which the spec requires even
   * when the cancellation itself found nothing to stop.
   */
  async cancel(sessionId: string): Promise<void> {
    if (!this.attachedSessions.has(sessionId)) return;
    const agent = await this.runtime.sessions().find(sessionId, this.scope);
    if (agent === undefined) return;
    this.runtime.sessions().interrupt(sessionId, agent);
  }

  async setConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const agent = await this.resolveAgent(params.sessionId);
    const sessions = this.runtime.sessions();
    const key = params.sessionId;
    const state = await this.stateFor(params.sessionId, agent);
    const outcome = decideConfigOption(state, params.configId, params.value);

    if (outcome.kind === "unknown") {
      // A list would be a lie here: there is nothing to report the current
      // value of, so this is the one set that is a genuine error.
      throw this.refuse(`No configuration option "${params.configId}".`);
    }
    if (outcome.kind === "refused") {
      this.runtime.context.logger.warn(
        {
          agent,
          session: params.sessionId,
          configId: params.configId,
          reason: outcome.reason,
        },
        "ACP config option change refused",
      );
      return { configOptions: configOptionsFor(state) };
    }
    if (outcome.kind === "agent") {
      // The conversation keeps its id and changes which persona answers
      // it: one record, one write, nothing left behind. This is what the
      // id being the identity buys.
      //
      // The runtime refuses the change against the record and its own
      // claim on the session, which is what settles a prompt racing this
      // set. Losing that race is a refusal like any other, and a refusal
      // is the unchanged list.
      try {
        await sessions.setAgent(params.sessionId, outcome.agent);
      } catch (err: unknown) {
        // Only the refusal answers as an unchanged list. A store that
        // failed is not a policy decision, and reporting it as one would
        // leave an editor with a list and no idea anything broke.
        if (rcCodeOf(err) !== "RC5003") throw err;
        this.runtime.context.logger.warn(
          {
            err,
            agent,
            session: params.sessionId,
            configId: params.configId,
          },
          "ACP persona change refused by the session runtime",
        );
        // Resolved again rather than reused: the persona this connection
        // read at the start of the request is exactly what another
        // connection may have just changed.
        return {
          configOptions: configOptionsFor(
            await this.stateFor(key, await this.resolveAgent(key)),
          ),
        };
      }
      this.attached(params.sessionId, outcome.agent, "new");
      const next = await this.stateFor(params.sessionId, outcome.agent);
      const options = configOptionsFor(next);
      await this.notifyConfig(params.sessionId, options);
      await this.notify(params.sessionId, {
        sessionUpdate: "current_mode_update",
        currentModeId: outcome.agent,
      });
      return { configOptions: options };
    }

    await sessions.configure(key, agent, outcome.overrides);
    const next = await this.stateFor(params.sessionId, agent);
    const options = configOptionsFor(next);
    await this.notifyConfig(params.sessionId, options);
    return { configOptions: options };
  }

  /**
   * The superseded modes API, mapped onto the persona config option so an
   * editor that speaks only the old one still switches personas.
   */
  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.setConfigOption({
      sessionId,
      configId: CONFIG_AGENT,
      value: modeId,
    });
  }

  // --------------------------------------------------------------- helpers

  /**
   * The persona a fresh conversation on this connection talks to.
   *
   * A connection that named one gets it, and is refused by name when the
   * instance does not hold it: a person who typed `--agent zoe` and
   * silently got somebody else would not find out until the answers read
   * wrong.
   */
  private agentForNewSession(): string {
    const requested = this.requestedAgent;
    if (requested === undefined) return this.runtime.defaultAgent();
    if (!this.runtime.agents().has(requested)) {
      throw this.refuse(
        `This instance has no agent named "${requested}". It has ${[...this.runtime.agents().keys()].map((name) => `"${name}"`).join(", ") || "none"}.`,
      );
    }
    return requested;
  }

  private async notifyConfig(
    sessionId: string,
    configOptions: SessionConfigOption[],
  ): Promise<void> {
    await this.notify(sessionId, {
      sessionUpdate: "config_option_update",
      configOptions,
    });
  }

  /**
   * Which agent a bare session id belongs to.
   *
   * The id is opaque, as the protocol has it, so the agent is resolved by
   * lookup rather than read out of the id. The lookup is bounded by the
   * caller's own sessions and runs per operation rather than once per
   * connection: the record is the only place the persona lives, and a
   * conversation open in two windows would otherwise have one of them
   * dispatching to a persona the other replaced.
   *
   * @throws AcpRequestError when the session is missing, or is not this caller's
   */
  private async resolveAgent(sessionId: string): Promise<string> {
    const agent = await this.runtime.sessions().find(sessionId, this.scope);
    if (agent === undefined) throw this.refuse(NO_SUCH_SESSION);
    return agent;
  }

  /** What the option builder needs about one session right now. */
  private async stateFor(
    sessionId: string,
    agent: string,
  ): Promise<ConfigOptionState & { cwd?: string }> {
    const summary = await this.runtime
      .sessions()
      .summary(sessionId, this.scope);
    if (summary === undefined) throw this.refuse(NO_SUCH_SESSION);
    const record = await this.runtime.sessions().store.load(sessionId);
    return {
      agent,
      agents: this.runtime.agents(),
      turns: summary.turns,
      running: summary.turn !== "idle",
      messages: summary.messages,
      overrides: record?.overrides,
      ...(summary.cwd !== undefined ? { cwd: summary.cwd } : {}),
    };
  }
}

/**
 * Wire this connection's handlers onto a fresh app.
 *
 * One app per connection, so nothing is shared between two callers and a
 * handler never has to ask whose request it is holding.
 *
 * @internal
 */
export function buildAcpApp(
  connection: AcpConnection,
  create: () => AgentApp,
): AgentApp {
  return create()
    .onConnect((open) => {
      connection.open(open.client, open.closed);
    })
    .onRequest("initialize", ({ params }) => connection.initialize(params))
    .onRequest("session/new", ({ params }) => connection.newSession(params))
    .onRequest("session/load", ({ params }) =>
      connection.loadSession(params.sessionId),
    )
    .onRequest("session/resume", ({ params }) =>
      connection.resumeSession(params.sessionId),
    )
    .onRequest("session/close", ({ params }) => {
      connection.closeSession(params.sessionId);
      return {};
    })
    .onRequest("session/list", ({ params }) =>
      connection.listSessions(params.cwd, params.cursor),
    )
    .onRequest("session/prompt", ({ params }) => connection.prompt(params))
    .onRequest("session/set_config_option", ({ params }) =>
      connection.setConfigOption(params),
    )
    .onRequest("session/set_mode", async ({ params }) => {
      await connection.setMode(params.sessionId, params.modeId);
      return {};
    })
    .onNotification("session/cancel", ({ params }) =>
      connection.cancel(params.sessionId),
    );
}

/**
 * The name the framework carries into an editor when nothing is
 * configured.
 *
 * The version is the real package version rather than a constant: an
 * editor logs and branches on it, and a frozen value would make every
 * Routecraft instance indistinguishable in their telemetry.
 */
const DEFAULT_AGENT_INFO = {
  name: "routecraft",
  title: "Routecraft",
  version: PACKAGE_VERSION,
};

/** A session as `session/list` reports it. */
function toSessionInfo(summary: AgentSessionSummary): SessionInfo {
  return {
    sessionId: summary.session,
    // The protocol requires a directory. A conversation a route opened has
    // none, and the empty string is what says "not bound to one" without
    // inventing a path this instance never saw.
    cwd: summary.cwd ?? "",
    ...(summary.title !== undefined ? { title: summary.title } : {}),
    updatedAt: summary.updatedAt,
  };
}

/** Modes ride alongside the config options, for the transition the spec asks for. */
function withModes(
  state: ConfigOptionState,
): { modes: SessionModeState } | Record<string, never> {
  const modes = modesFor(state);
  return modes === undefined ? {} : { modes };
}

/**
 * The user's message, from the content blocks the client sent.
 *
 * Text is taken as written. A resource link renders as its name and uri,
 * which is what a model can act on without the file itself. Image and
 * audio are refused: we advertised them false, so a conforming client
 * never sends one, and silently dropping it would answer a question the
 * person did not ask.
 */
function promptText(
  blocks: readonly ContentBlock[],
  refuse: (message: string) => Error,
): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push(block.text);
      continue;
    }
    if (block.type === "resource_link") {
      parts.push(`${block.name} (${block.uri})`);
      continue;
    }
    throw refuse(
      `This agent does not accept "${block.type}" content in a prompt.`,
    );
  }
  const text = parts.join("\n\n").trim();
  if (text === "") throw refuse("The prompt carried no text.");
  return text;
}

/** A short human-readable name for a conversation, from its first message. */
function titleFrom(message: string): string {
  const line = message.split("\n", 1)[0]!.trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/**
 * Why the turn stopped.
 *
 * An interrupted turn is `cancelled`, which is what a person who pressed
 * stop is entitled to see. Everything else ended the turn: a queued
 * message is answered by the turn that consumes it, and an idle revival
 * had nothing to run.
 */
function stopReasonFor(status: string | undefined): StopReason {
  return status === "interrupted" ? "cancelled" : "end_turn";
}
