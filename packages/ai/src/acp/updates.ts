/**
 * The merge: two producers, one queue, one pump.
 *
 * A turn produces updates on two channels with no ordering between them.
 * Token deltas arrive on the agent's directed `onDelta` listener, which is
 * awaited, so back-pressure on a slow editor reaches the model. Tool
 * lifecycle events arrive on the context bus, which is broadcast and
 * synchronous, so nothing can be awaited there at all.
 *
 * Both enqueue synchronously at the moment the thing happened, and one
 * pump drains the queue in order. Ordering on the wire is then the real
 * ordering: a tool call raised between two text deltas arrives between
 * them, which is what a person watching the turn is entitled to see.
 */

import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentDelta } from "../agent/events.ts";

/** Where a turn's updates go. Returns once the update has been handed over. */
export type UpdateSink = (update: SessionUpdate) => Promise<void>;

/**
 * One turn's ordered channel to the editor.
 *
 * `push` is safe to call from a synchronous bus handler and from an
 * awaited delta listener alike. The promise it returns settles when that
 * update has left the queue, which is what makes the delta listener a
 * back-pressure point and the bus handler merely a producer.
 */
export class TurnUpdates {
  private readonly queue: Array<{
    readonly update: SessionUpdate;
    readonly settle: (error?: unknown) => void;
  }> = [];
  private pumping = false;
  private drained: Promise<void> = Promise.resolve();
  private closed = false;
  private sentMessage = false;

  constructor(private readonly sink: UpdateSink) {}

  /**
   * Enqueue one update. Enqueueing is synchronous; the promise resolves
   * when the pump has sent it.
   *
   * An update pushed after the turn closed is dropped rather than sent:
   * the turn is over, and a late delta arriving after the prompt response
   * would reach a client that has already moved on.
   */
  push(update: SessionUpdate): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (update.sessionUpdate === "agent_message_chunk") {
      this.sentMessage = true;
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({
        update,
        settle: (error) => (error === undefined ? resolve() : reject(error)),
      });
      this.pump();
    });
  }

  /**
   * Whether any of the agent's own words have gone to the editor.
   *
   * A provider that streams sends them as deltas. One that does not sends
   * nothing at all until the turn ends, and the person would watch an
   * empty window while the answer sat in the result; this is how the turn
   * knows to send it once at the end instead.
   */
  get sentAnyMessage(): boolean {
    return this.sentMessage;
  }

  /**
   * Stop taking updates and wait for what is already queued.
   *
   * Called at the end of a turn, before the prompt response goes back, so
   * every update a person was going to see has been sent by the time the
   * turn is reported finished.
   */
  async close(): Promise<void> {
    this.closed = true;
    await this.drained;
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    this.drained = this.drain();
    // Nobody awaits `drained` except close(); a failure reaches whoever
    // pushed the failing update through its own promise.
    this.drained.catch(() => undefined);
  }

  private async drain(): Promise<void> {
    for (;;) {
      const next = this.queue.shift();
      if (next === undefined) {
        // Cleared here, synchronously with the shift that found the queue
        // empty, rather than in a `finally` on this promise. A producer
        // awaiting the update it just pushed resumes in a microtask after
        // `settle`, and with the flag cleared one turn later that producer
        // would enqueue its next update while the pump still looked busy,
        // and nothing would ever drain it.
        this.pumping = false;
        return;
      }
      try {
        await this.sink(next.update);
        next.settle();
      } catch (error: unknown) {
        next.settle(error);
      }
    }
  }
}

/** A text delta becomes a message chunk; a reasoning delta becomes a thought. */
export function deltaUpdate(delta: AgentDelta): SessionUpdate {
  return delta.type === "reasoning-delta"
    ? {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: delta.text },
      }
    : {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: delta.text },
      };
}

/**
 * A tool call starting.
 *
 * `kind` is always `other`. A Routecraft tool is a route and carries no
 * semantic tag, and the editor picks an icon from this field: sending a
 * wrong kind is worse than sending none.
 */
export function toolCallUpdate(
  toolCallId: string,
  toolName: string,
  input: unknown,
  payloads: boolean,
): SessionUpdate {
  return {
    sessionUpdate: "tool_call",
    toolCallId,
    title: toolName,
    kind: "other",
    status: "in_progress",
    ...(payloads ? { rawInput: input } : {}),
  };
}

/** A tool call that produced a result. */
export function toolResultUpdate(
  toolCallId: string,
  output: unknown,
  payloads: boolean,
): SessionUpdate {
  return {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: "completed",
    ...(payloads ? { rawOutput: output } : {}),
  };
}

/**
 * A tool call that failed or was refused.
 *
 * The reason is carried as content rather than as a raw payload, because
 * it is what a person needs to read whether or not the instance withholds
 * arguments and results.
 */
export function toolFailedUpdate(
  toolCallId: string,
  reason: string,
): SessionUpdate {
  return {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: "failed",
    content: [{ type: "content", content: { type: "text", text: reason } }],
  };
}
