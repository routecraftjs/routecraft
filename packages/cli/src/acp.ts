/**
 * `craft acp`: the pipe an editor runs.
 *
 * An editor starts one process and speaks the Agent Client Protocol to it
 * over its standard input and output. This is that process, and it is a
 * pipe and nothing else: newline-delimited JSON on the editor side,
 * Streamable HTTP on the instance side, every message forwarded verbatim
 * in both directions.
 *
 * It never starts an app. `craft start` owns running, which is what makes
 * one editor entry reach a laptop or a company instance by switching a
 * profile and changing nothing else.
 *
 * There is no login. A token in the profile authenticates, exactly as
 * `token:` does today for every other command, and an agent that
 * advertises no authentication method is conforming.
 */

import { Readable } from "node:stream";

import {
  describeSource,
  resolveSettings,
  SettingsError,
  type SettingsOverrides,
} from "./settings.js";
import { EXEC_EXIT } from "./exec.js";
import { refuseClearTextBearer } from "./ops-client.js";
import { messageOf } from "./util.js";

/**
 * The path the protocol is mounted on.
 *
 * Not configurable from here on purpose: the mount's own `path` option is
 * the instance's to choose, and a person pointing an editor at an instance
 * that moved it says so with the full URL.
 */
const ACP_PATH = "/acp";

/**
 * Request header naming the agent this connection wants to talk to.
 *
 * The protocol has no field for it, and inventing one in `_meta` would be
 * a private extension a conforming client could not be expected to send.
 * A header keeps the bridge a pipe: it adds one, exactly as it adds
 * `Authorization`.
 *
 * Spelled once here rather than shared with the mount, because the CLI
 * does not depend on `@routecraft/ai`: the mount exports the same constant
 * and a test pins the two together.
 */
export const ACP_AGENT_HEADER = "Routecraft-Agent";

/** What `craft acp` answers with when it stops. */
export interface AcpResult {
  code: number;
  /** Written to standard error. Standard output belongs to the protocol. */
  error?: string;
}

export interface AcpOptions extends SettingsOverrides {
  /** The editor's side of the pipe. Defaults to this process's streams. */
  stdin?: ReadableStream<Uint8Array>;
  stdout?: WritableStream<Uint8Array>;
}

/**
 * Standard output as a writable stream of bytes.
 *
 * Written through `process.stdout` rather than a Bun file handle: the
 * protocol's frames are small and frequent, and the node stream is what
 * flushes each one as it is written rather than when a buffer fills.
 */
function stdoutStream(): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        process.stdout.write(chunk, (error) =>
          error ? reject(error) : resolve(),
        );
      });
    },
  });
}

/**
 * Standard input as a readable stream of bytes.
 *
 * Through `node:stream` rather than a Bun-only global: the CLI runs on Bun
 * today, and there is no reason for the one line that reads a pipe to be
 * the thing that pins it there.
 */
function stdinStream(): ReadableStream<Uint8Array> {
  // The node types describe a web stream of `any`; the bytes are what a
  // pipe carries either way, and the SDK reads them as bytes.
  return Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
}

/**
 * Run the bridge until the editor closes its side or the instance drops.
 *
 * Both halves are the SDK's own transports, so nothing here parses the
 * protocol: a message that arrives is a message that is forwarded, and a
 * version of the protocol this build has never heard of passes through
 * unchanged.
 */
export async function acpCommand(options: AcpOptions = {}): Promise<AcpResult> {
  let settings;
  try {
    settings = resolveSettings(options);
  } catch (error: unknown) {
    if (error instanceof SettingsError)
      return { code: 2, error: error.message };
    throw error;
  }

  const { ndJsonStream } = await import("@agentclientprotocol/sdk");
  const { createHttpStream, MemoryAcpCookieStore } =
    await import("@agentclientprotocol/sdk/experimental/http-client");

  const headers: Record<string, string> = {};
  if (settings.token !== undefined) {
    // The same refusal `craft exec` and `craft ops` make: a bearer does not
    // go over cleartext to anything but this machine. An editor holds this
    // connection open all day, so it is the longest-lived place a token
    // would be on the wire.
    try {
      refuseClearTextBearer(settings);
    } catch (error: unknown) {
      if (error instanceof SettingsError)
        return { code: 2, error: error.message };
      throw error;
    }
    headers["Authorization"] = `Bearer ${settings.token.value}`;
  }
  if (settings.agent !== undefined) {
    headers[ACP_AGENT_HEADER] = settings.agent.value;
  }

  const url = `${settings.url.value.replace(/\/+$/, "")}${ACP_PATH}`;
  // One cookie store for the process: the SDK uses it for routing
  // affinity, so a reconnect lands on the instance that holds the
  // conversation rather than on a sibling behind the same address.
  const instance = createHttpStream(url, {
    headers,
    cookieStore: new MemoryAcpCookieStore(),
  });
  const editor = ndJsonStream(
    options.stdout ?? stdoutStream(),
    options.stdin ?? stdinStream(),
  );

  try {
    // Both directions are awaited, and one ending settles the other
    // through the streams themselves rather than through anything here.
    // `pipeTo` closes its destination when its source ends, so an editor
    // closing stdin closes the transport's writable, which closes the
    // transport, which closes the readable the other direction is reading;
    // a transport that fails errors that readable instead. Either way both
    // settle. The tests hold this: an instance stopped while stdin is
    // deliberately left open still ends the bridge.
    await Promise.all([
      editor.readable.pipeTo(instance.writable),
      instance.readable.pipeTo(editor.writable),
    ]);
    return { code: 0 };
  } catch (error: unknown) {
    // The family's code for an address nothing answered on, so a script
    // that already branches on `craft exec`'s exit codes reads this one
    // the same way.
    return {
      code: EXEC_EXIT.unreachable,
      error: `Lost the connection to ${url} (from the ${describeSource(settings.url)}): ${messageOf(error)}`,
    };
  }
}
