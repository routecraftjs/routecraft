/**
 * `craft chat`: a conversation with an agent session on a running
 * instance, one message per line.
 *
 * A loop over the same primitive `craft exec` uses: every line is a
 * dispatch of `{ session, message }` to the route fronting the agent,
 * through the management door, and the reply is printed. The terminal owns
 * nothing: the conversation lives in the instance's store under the
 * session id, so the loop can be killed and reattached with the same id,
 * from here or from another machine, and a webhook or a mail reply can
 * post into the same session while it is open.
 *
 * The route is the app's, with its own guardrails: `.authorize()`,
 * `.input()` and `.throttle()` run per message. Addressing an agent by its
 * registry name with no route in front is #599's open question and is not
 * built here.
 */

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { OpsClientError, type OpsClient } from "./ops-client.js";
import { asJson, renderDispatch } from "./format.js";
import { EXEC_EXIT, failureCode, type ExecResult } from "./exec.js";
import { prepare } from "./prepare.js";
import type { OutputFormat, SettingsOverrides } from "./settings.js";

/**
 * A line sink. The promise, when one is returned, is awaited before the
 * next message is sent and before the command resolves: `process.stdout`
 * is asynchronous on a pipe and `process.exit` discards what is still
 * queued, so a reply is only safe once its write has settled.
 */
export type ChatWriter = (text: string) => unknown;

export interface ChatOptions extends SettingsOverrides {
  /** The conversation to continue. A fresh id is minted and printed when absent. */
  session?: string;
  /**
   * The messages, one per item. Defaults to the lines of standard input.
   * Injectable so a test can drive a conversation without a terminal.
   */
  input?: AsyncIterable<string> | Iterable<string>;
  /** Where replies go. Defaults to standard output. */
  write?: ChatWriter;
  /**
   * Where a minted session id goes under `json` and `raw`, so standard
   * output stays a stream of replies. Defaults to standard error.
   */
  writeStderr?: ChatWriter;
}

/**
 * What an agent route answers, read structurally: the CLI does not depend
 * on `@routecraft/ai`, and a route that fronts an agent may reshape the
 * result on its way out.
 */
interface AgentShapedReply {
  text: string;
  session?: { status?: string; queued?: number };
}

function isAgentShaped(body: unknown): body is AgentShapedReply {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { text?: unknown }).text === "string"
  );
}

/**
 * Run the conversation until the input ends.
 *
 * Exit codes are `craft exec`'s. A door that refuses, an instance that
 * cannot be reached, or a route that cannot be dispatched ends the loop
 * with that code: nothing sent after it would fare better. A route that
 * ran and failed on one message is printed and the loop continues, because
 * the conversation is still there.
 */
export async function chatCommand(
  route: string | undefined,
  options: ChatOptions = {},
): Promise<ExecResult> {
  const prepared = prepare(options);
  if (!prepared.ok) return { code: EXEC_EXIT.usage, error: prepared.error };
  if (route === undefined || route.trim() === "") {
    return { code: EXEC_EXIT.usage, error: USAGE };
  }

  const { client, format, settings } = prepared;
  const session = options.session ?? randomUUID();
  const write = options.write ?? lineTo(process.stdout);
  const writeStderr = options.writeStderr ?? lineTo(process.stderr);

  if (format === "pretty") {
    await write(
      `Session ${session} on route "${route}" at ${settings.url.value}. One message per line; end the input (Ctrl-D) to leave. The conversation stays in the instance: reattach with --session ${session}.`,
    );
  } else if (options.session === undefined) {
    await writeStderr(`Session ${session}: reattach with --session ${session}`);
  }

  for await (const raw of options.input ?? lines()) {
    const message = raw.trim();
    if (message === "") continue;
    const outcome = await turn(client, route, session, message, format, write);
    if (outcome !== undefined) return outcome;
  }
  return { code: EXEC_EXIT.ok };
}

/** One message: dispatch, print, and say whether the loop must end. */
async function turn(
  client: OpsClient,
  route: string,
  session: string,
  message: string,
  format: OutputFormat,
  write: ChatWriter,
): Promise<ExecResult | undefined> {
  try {
    const outcome = await client.dispatch(route, { session, message });
    if (format === "json") {
      await write(asJson(outcome));
      return undefined;
    }
    if (outcome.outcome === "completed" && isAgentShaped(outcome.body)) {
      await write(renderReply(outcome.body, format));
      return undefined;
    }
    await write(renderDispatch(outcome, format));
    return undefined;
  } catch (error: unknown) {
    if (!(error instanceof OpsClientError)) throw error;
    // The dispatch surface answers 500 for a route that ran and failed, and
    // that failure is this message's, not the conversation's. Every other
    // status (409 for a route with no dispatch door, a proxy's 502) is
    // about the command, not the message.
    if (error.kind === "error" && error.status === 500) {
      await write(renderFailure(error, format));
      return undefined;
    }
    return { code: failureCode(error), error: error.message };
  }
}

/**
 * A failed message, in the stream's own shape: a prose line would break a
 * `json` consumer that reads one object per message.
 */
function renderFailure(error: OpsClientError, format: OutputFormat): string {
  if (format !== "json") return `(the route failed: ${error.message})`;
  const code = wireCodeOf(error.detail);
  return asJson({
    outcome: "failed",
    message: error.message,
    ...(code === undefined ? {} : { code }),
  });
}

/** The framework error code the dispatch surface put on the wire, if any. */
function wireCodeOf(detail: unknown): string | undefined {
  if (typeof detail !== "object" || detail === null) return undefined;
  const code = (detail as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * The reply as a person reads it. A queued message was acknowledged, not
 * answered: the turn that consumes it replies into the transcript, and
 * saying so beats printing an empty line.
 */
function renderReply(reply: AgentShapedReply, format: OutputFormat): string {
  const status = reply.session?.status;
  if (status === "queued") {
    const depth = reply.session?.queued;
    return format === "raw"
      ? ""
      : `(queued: a turn is running, so this message is delivered at its boundary${depth !== undefined ? `, ${String(depth)} waiting` : ""}. Its reply lands in the transcript.)`;
  }
  if (status === "interrupted") {
    return format === "raw" ? "" : "(interrupted by a later message)";
  }
  return reply.text;
}

/** A writer whose promise settles once the stream has taken the line. */
function lineTo(stream: NodeJS.WriteStream): ChatWriter {
  return (text) =>
    new Promise<void>((resolve) => {
      stream.write(`${text}\n`, () => resolve());
    });
}

/** Standard input as lines, for a terminal or a pipe alike. */
async function* lines(): AsyncIterable<string> {
  const reader = createInterface({ input: process.stdin, terminal: false });
  try {
    for await (const line of reader) yield line;
  } finally {
    reader.close();
  }
}

const USAGE = [
  "Usage: craft chat [options] <route>",
  "",
  "Options:",
  "  --session <id>     Conversation to continue (default: a fresh id, printed at the start)",
  "  --url <url>        Instance ops server (default: the settings file, else http://127.0.0.1:8080)",
  "  --token <token>    Bearer credential presented at the management door",
  "  --format <format>  pretty (default), json, or raw",
  "",
  "<route> is the route fronting the agent: one that takes { session, message } and dispatches agent(name, { session }).",
].join("\n");
