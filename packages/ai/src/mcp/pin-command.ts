import { readFile, rename, writeFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import type { AuthProvider } from "@modelcontextprotocol/client";
import {
  evaluateEnablementOnce,
  rcError,
  type CraftConfig,
  type CredentialStore,
  type ProjectCommand,
} from "@routecraft/routecraft";
import { isConnectAuth, storedAuthProvider } from "./connect.ts";
import { createMcpHttpConnections } from "./http-connections.ts";
import {
  lockfilePath,
  lockTools,
  ownRecord,
  parseLockfile,
  serializeLockfile,
  type McpLockedTool,
  type McpLockfile,
} from "./pins.ts";
import {
  configuredMcpOptions,
  isStdioConfig,
  stdioManagerOptions,
} from "./plugin.ts";
import { assertRemoteUrl } from "./sdk.ts";
import { StdioClientManager } from "./stdio-client-manager.ts";
import type {
  McpClientServerConfig,
  McpClientStdioConfig,
  McpTool,
  McpToolClass,
} from "./types.ts";

/**
 * What `craft mcp pin` asks for.
 *
 * @internal
 */
export interface McpPinRequest {
  /** The one client to pin. Every client that sets `pins` when left out. */
  readonly client?: string | undefined;
  /** Opens the credential store, called only for a client that logs in with `connect()`. */
  readonly credentials: () => Promise<CredentialStore>;
}

/**
 * How one client's listing compares with what the lockfile held.
 *
 * @internal
 */
export interface McpPinnedClient {
  readonly id: string;
  /** Tools the lockfile had not seen, each with the class proposed for it. */
  readonly added: ReadonlyArray<{ name: string; class: McpToolClass }>;
  /** Tools whose definition differs from the locked one. */
  readonly changed: readonly string[];
  /** Locked tools the server no longer lists. */
  readonly removed: readonly string[];
  readonly unchanged: number;
}

/**
 * What `craft mcp pin` did.
 *
 * @internal
 */
export interface McpPinResult {
  /** The lockfile's path. */
  readonly path: string;
  /** Whether the file's bytes changed. */
  readonly written: boolean;
  readonly clients: readonly McpPinnedClient[];
  /** Clients that could not be listed, whose locked tools were kept as they were. */
  readonly failed: ReadonlyArray<{ id: string; reason: string }>;
}

/**
 * List the configured clients and write what they list to the lockfile.
 *
 * Each tool's definition and hash are replaced by what its server lists
 * now. A class already in the file is kept, and a new tool gets a proposed
 * one. Nothing is approved by running this: the lockfile is approved by
 * committing it, and the diff is what there is to review.
 *
 * A client that cannot be listed keeps its locked tools untouched, so one
 * unreachable server does not unpin itself.
 *
 * @throws RC5003 when no client can be selected, or the existing lockfile
 *   is not one this version reads
 * @internal
 */
export async function pinMcpClients(
  config: CraftConfig,
  request: McpPinRequest,
): Promise<McpPinResult> {
  const sources = configuredMcpOptions(config);
  const configured = new Map<string, McpClientServerConfig>();
  for (const options of sources) {
    for (const [id, client] of Object.entries(options.clients ?? {})) {
      if (!configured.has(id)) configured.set(id, client);
    }
  }
  const targets =
    request.client !== undefined
      ? [...configured.keys()].filter((id) => id === request.client)
      : [...configured].flatMap(([id, client]) =>
          client.pins !== undefined ? [id] : [],
        );
  if (targets.length === 0) {
    const known = [...configured.keys()].join(", ");
    throw rcError("RC5003", undefined, {
      message:
        request.client !== undefined
          ? `No MCP client is named "${request.client}". ${known === "" ? "None is configured." : `Those configured: ${known}.`}`
          : "No MCP client sets pins, so there is nothing to pin.",
      suggestion:
        "Set pins on a client in craft.config.ts, for example pins: {}, or name the client to pin.",
    });
  }

  const path = lockfilePath(
    sources.find((options) => options.lockfile !== undefined)?.lockfile,
  );
  const existing = await readExisting(path);
  const previous =
    existing === undefined ? undefined : parseLockfile(existing, path);

  const clients: McpLockfile["clients"] = ownRecord();
  for (const id of configured.keys()) {
    const kept = previous?.clients[id];
    if (kept !== undefined) clients[id] = kept;
  }
  const pinned: McpPinnedClient[] = [];
  const failed: Array<{ id: string; reason: string }> = [];
  for (const id of targets) {
    const before = clients[id]?.tools;
    try {
      const tools = lockTools(
        await listClient(id, configured.get(id)!, request),
        before,
      );
      clients[id] = { tools };
      pinned.push(compare(id, before ?? ownRecord(), tools));
    } catch (error) {
      failed.push({
        id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const text = serializeLockfile({ version: 1, clients });
  const written = pinned.length > 0 && text !== existing;
  if (written) {
    // Through a rename, so a reader never sees half a lockfile.
    const partial = `${path}.${process.pid}.tmp`;
    await writeFile(partial, text);
    await rename(partial, path);
  }
  return { path, written, clients: pinned, failed };
}

async function readExisting(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function compare(
  id: string,
  before: Record<string, McpLockedTool>,
  after: Record<string, McpLockedTool>,
): McpPinnedClient {
  const added: Array<{ name: string; class: McpToolClass }> = [];
  const changed: string[] = [];
  let unchanged = 0;
  for (const [name, tool] of Object.entries(after)) {
    const was = Object.hasOwn(before, name) ? before[name] : undefined;
    if (was === undefined) added.push({ name, class: tool.class });
    else if (was.hash !== tool.hash) changed.push(name);
    else unchanged++;
  }
  const removed = Object.keys(before).filter(
    (name) => !Object.hasOwn(after, name),
  );
  return { id, added, changed, removed, unchanged };
}

/** The tools one configured client lists now, on its own credential. */
async function listClient(
  id: string,
  client: McpClientServerConfig,
  request: McpPinRequest,
): Promise<McpTool[]> {
  if (client.enabled !== undefined) {
    const state = await evaluateEnablementOnce(
      client.enabled,
      `MCP client "${id}" enabled`,
      () => undefined,
    );
    if (!state.enabled) {
      throw new Error(`the client is disabled (${state.reason})`);
    }
  }
  if (isStdioConfig(client)) return listStdio(id, client);
  assertRemoteUrl(
    client.url,
    client.allowHttp === true,
    `mcpPlugin: clients.${id}.url`,
  );
  const authProviders = new Map<string, AuthProvider>();
  let loginRequired: string | undefined;
  if (isConnectAuth(client.auth)) {
    authProviders.set(
      id,
      storedAuthProvider(
        id,
        client.auth,
        await request.credentials(),
        (why) => {
          loginRequired = why;
        },
      ),
    );
  }
  const connections = createMcpHttpConnections({ authProviders });
  try {
    return (await connections.listTools(id, client)).tools ?? [];
  } catch (error) {
    if (loginRequired === undefined) throw error;
    throw new Error(loginRequired, { cause: error });
  } finally {
    await connections.disposeAll(() => undefined);
  }
}

async function listStdio(
  id: string,
  client: McpClientStdioConfig,
): Promise<McpTool[]> {
  let listed: McpTool[] | undefined;
  const quiet = () => undefined;
  const manager = new StdioClientManager(
    stdioManagerOptions(id, client, {
      maxRestarts: 0,
      restartDelayMs: 0,
      restartBackoffMultiplier: 1,
    }),
    { info: quiet, debug: quiet, warn: quiet, error: quiet },
    quiet,
    (_id, tools) => {
      listed = tools;
    },
  );
  try {
    await manager.start();
    if (listed !== undefined) return listed;
    const failure = manager.lastListingError;
    throw new Error(
      failure instanceof Error
        ? failure.message
        : "the server did not list its tools",
      { cause: failure },
    );
  } finally {
    await manager.stop().catch(() => undefined);
  }
}

/**
 * Text a remote server chose, made safe to print: anything outside
 * printable ASCII becomes a `\u` escape, so a tool name or an error cannot
 * move the cursor or hide part of the lines a reviewer reads.
 */
function printable(text: string): string {
  return text.replace(
    /[^\x20-\x7e]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * `craft mcp pin [client]`: write what the configured MCP clients list now
 * to the lockfile, and say what changed. The lockfile is approved by
 * committing it, so the output names the changes and leaves the review to
 * the diff.
 *
 * @internal
 */
export const mcpPinCommand: ProjectCommand = async (config, io) => {
  if (io.args.length > 1) {
    return { code: 1, error: "craft mcp pin takes at most one client." };
  }
  const result = await pinMcpClients(config, {
    client: io.args[0],
    credentials: io.credentials,
  });
  const lines: string[] = [];
  for (const each of result.clients) {
    const total = each.added.length + each.changed.length + each.unchanged;
    lines.push(
      `${each.id}: ${total} tools, ${each.added.length} added, ${each.changed.length} changed, ${each.removed.length} removed`,
    );
    for (const tool of each.added) {
      lines.push(`  + ${printable(tool.name)}  (class: ${tool.class})`);
    }
    for (const name of each.changed) lines.push(`  ~ ${printable(name)}`);
    for (const name of each.removed) lines.push(`  - ${printable(name)}`);
  }
  if (result.clients.length > 0) {
    const shown = relative(io.root, result.path);
    const file =
      shown === ".." || shown.startsWith(`..${sep}`) ? result.path : shown;
    lines.push(
      result.written
        ? `Wrote ${file}. Check the class of each added tool, review the diff, and commit it to approve.`
        : `${file} is up to date.`,
    );
  }
  const errors = result.failed.map(
    (each) =>
      `"${each.id}" was not listed, and its locked tools are unchanged: ${printable(each.reason)}`,
  );
  return {
    code: errors.length > 0 ? 1 : 0,
    ...(lines.length > 0 ? { output: lines.join("\n") } : {}),
    ...(errors.length > 0 ? { error: errors.join("\n") } : {}),
  };
};
