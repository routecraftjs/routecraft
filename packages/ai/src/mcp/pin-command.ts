import { readFile, rename, writeFile } from "node:fs/promises";
import type { AuthProvider } from "@modelcontextprotocol/client";
import {
  evaluateEnablementOnce,
  rcError,
  type CraftConfig,
  type CredentialStore,
} from "@routecraft/routecraft";
import {
  coalescedAuthProvider,
  isConnectAuth,
  StoreOAuthProvider,
} from "./connect.ts";
import { createMcpHttpConnections } from "./http-connections.ts";
import {
  lockfilePath,
  lockTools,
  parseLockfile,
  serializeLockfile,
  type McpLockedTool,
  type McpLockfile,
} from "./pins.ts";
import { mcpPluginOptions } from "./plugin.ts";
import { assertRemoteUrl } from "./sdk.ts";
import { StdioClientManager } from "./stdio-client-manager.ts";
import type {
  McpClientServerConfig,
  McpClientStdioConfig,
  McpPluginOptions,
  McpTool,
  McpToolClass,
} from "./types.ts";

/** What `craft mcp pin` asks for. */
export interface McpPinRequest {
  /** The one client to pin. Every client that sets `pins` when left out. */
  readonly client?: string | undefined;
  /** Opens the credential store, called only for a client that logs in with `connect()`. */
  readonly credentials: () => Promise<CredentialStore>;
}

/** How one client's listing compares with what the lockfile held. */
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

/** What `craft mcp pin` did. */
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
  const sources: McpPluginOptions[] = [
    config.mcp,
    ...(config.plugins ?? []).map((plugin) => mcpPluginOptions(plugin)),
  ].filter((options) => options !== undefined);
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

  const clients: McpLockfile["clients"] = {};
  for (const id of configured.keys()) {
    const kept = previous?.clients[id];
    if (kept !== undefined) clients[id] = kept;
  }
  const pinned: McpPinnedClient[] = [];
  const failed: Array<{ id: string; reason: string }> = [];
  for (const id of targets) {
    const before = previous?.clients[id]?.tools;
    try {
      const tools = lockTools(
        await listClient(id, configured.get(id)!, request),
        before,
      );
      clients[id] = { tools };
      pinned.push(compare(id, before ?? {}, tools));
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
  if ("transport" in client && client.transport === "stdio") {
    return listStdio(id, client);
  }
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
      coalescedAuthProvider(
        new StoreOAuthProvider({
          serverId: id,
          options: client.auth.options,
          store: await request.credentials(),
          onLoginRequired: (why) => {
            loginRequired = why;
          },
        }),
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
  let failure: unknown;
  const quiet = () => undefined;
  const manager = new StdioClientManager(
    {
      serverId: id,
      command: client.command,
      args: client.args ?? [],
      ...(client.env !== undefined ? { env: client.env } : {}),
      ...(client.cwd !== undefined ? { cwd: client.cwd } : {}),
      maxRestarts: 0,
      restartDelayMs: 0,
      restartBackoffMultiplier: 1,
    },
    {
      info: quiet,
      debug: quiet,
      warn: (bindings) => {
        failure ??= bindings["err"];
      },
      error: (bindings) => {
        failure ??= bindings["err"];
      },
    },
    quiet,
    (_id, tools) => {
      listed = tools;
    },
  );
  try {
    await manager.start();
  } finally {
    await manager.stop().catch(() => undefined);
  }
  if (listed === undefined) {
    throw new Error(
      failure instanceof Error
        ? failure.message
        : "the server did not list its tools",
      { cause: failure },
    );
  }
  return listed;
}
