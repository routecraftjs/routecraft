import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type {
  CredentialLogin,
  CredentialLoginIO,
  CredentialStore,
  CraftConfig,
} from "@routecraft/routecraft";
import type { ExecResult } from "./exec.js";
import { displayPath, findConfigFile } from "./project.js";
import { messageOf } from "./util.js";

/** What a credential command prints and exits with, as `settle` takes it. */
export type CommandResult = ExecResult;

/** Options of `craft connect`. */
export interface ConnectOptions {
  /** Log in every declared client that has no stored credential. */
  all?: boolean;
  /** Print a sealed seed of the credentials instead of only storing them. */
  export?: boolean;
  /** Show each declared client and whether it holds a credential. */
  list?: boolean;
  /** Print the authorization URL without opening a browser. */
  open?: boolean;
  /** Loopback port for the redirect; any free port when unset. */
  port?: string;
  /**
   * Where the login instructions go; standard error when unset. Tests pass
   * their own, because touching `process.stderr` under Bun switches the
   * shared output pipe to non-blocking for the rest of the run.
   */
  stderr?: (text: string) => void;
}

/** How long a login waits for the person to come back from the browser. */
const CALLBACK_TIMEOUT_MS = 5 * 60_000;

/** The path the authorization server redirects to on the loopback listener. */
const CALLBACK_PATH = "/callback";

/**
 * Log a configured client in and store its credential, where the
 * application will read it.
 *
 * - `craft connect <client>` logs in one client, replacing what it held.
 * - `craft connect --all` logs in every client that holds nothing.
 * - `--export` prints a seed of the credentials for a server to import,
 *   logging in first only a client that holds nothing.
 * - `--list` shows every declared client and what it holds.
 */
export async function connectCommand(
  client: string | undefined,
  options: ConnectOptions = {},
): Promise<CommandResult> {
  let session: Session;
  try {
    session = await openSession();
  } catch (error: unknown) {
    return { code: 1, error: messageOf(error) };
  }
  try {
    if (options.list) return await list(session);
    const core = await import("@routecraft/routecraft");
    const sealer = core.sealerFromEnv(process.env);
    if (options.export && sealer === undefined) {
      return {
        code: 1,
        error: `--export seals the credentials, and ${core.CREDENTIALS_KEY_ENV} is not set. Set it here and on the server that imports the seed.`,
      };
    }

    const targets = selectTargets(
      session.logins,
      client,
      options.all,
      options.export,
    );
    if (typeof targets === "string") return { code: 1, error: targets };

    const notes: string[] = [];
    const failed: string[] = [];
    for (const login of targets) {
      const held = await session.store.get(login.owner);
      // A named client is logged in again on request; an export or --all
      // keeps what is held, which is the point of exporting it.
      const relogin = client !== undefined && !options.export;
      if (held !== undefined && !relogin) continue;
      try {
        await runLogin(session.store, login, options);
        notes.push(`Connected "${login.id}".`);
      } catch (error: unknown) {
        // One refused login does not cost the others in the same run.
        if (targets.length === 1) throw error;
        failed.push(`"${login.id}" did not connect: ${messageOf(error)}`);
      }
    }
    if (failed.length > 0) {
      return {
        code: 1,
        ...(notes.length > 0 ? { output: notes.join("\n") } : {}),
        error: failed.join("\n"),
      };
    }

    if (options.export && sealer !== undefined) {
      const entries = [];
      for (const login of targets) {
        const held = await session.store.get(login.owner);
        if (held === undefined) continue;
        entries.push({
          owner: login.owner,
          value: held.value,
          issuedAt: held.issuedAt,
        });
      }
      if (entries.length === 0) {
        return { code: 1, error: "No stored credential to export." };
      }
      return {
        code: 0,
        output: core.encodeCredentialSeed(entries, sealer),
        error: [
          ...notes,
          `Set ${core.CREDENTIALS_SEED_ENV} on the server to the line above, with the same ${core.CREDENTIALS_KEY_ENV}.`,
        ].join("\n"),
      };
    }
    if (notes.length === 0) {
      return { code: 0, output: "Every client already holds a credential." };
    }
    return { code: 0, output: notes.join("\n") };
  } catch (error: unknown) {
    return { code: 1, error: messageOf(error) };
  } finally {
    await session.close();
  }
}

/** Remove a client's stored credential, so the application disables it. */
export async function disconnectCommand(
  client: string,
): Promise<CommandResult> {
  let session: Session;
  try {
    session = await openSession();
  } catch (error: unknown) {
    return { code: 1, error: messageOf(error) };
  }
  try {
    // A client removed from the config leaves its credential behind;
    // naming the stored owner, as --list shows it, still reaches it.
    const owner =
      session.logins.find((each) => each.id === client)?.owner ??
      (await session.store.list()).find((each) => each.owner === client)?.owner;
    if (owner === undefined) {
      return { code: 1, error: unknownClient(session.logins, client) };
    }
    const removed = await session.store.delete(owner);
    return {
      code: 0,
      output: removed
        ? `Disconnected "${client}". A running application finds the credential gone on its next call to the client and disables it.`
        : `"${client}" held no credential.`,
    };
  } catch (error: unknown) {
    return { code: 1, error: messageOf(error) };
  } finally {
    await session.close();
  }
}

interface Session {
  logins: CredentialLogin[];
  store: CredentialStore;
  close(): Promise<void>;
}

/**
 * The project's declared logins and its credential store, opened the way
 * the application opens it so a login writes where the application reads.
 */
async function openSession(): Promise<Session> {
  const root = process.cwd();
  const configPath = findConfigFile(root);
  if (configPath === undefined) {
    throw new Error(
      `No craft.config.ts found in "${root}". craft connect reads the clients to log in from it.`,
    );
  }
  const { loadConfig, projectContentRoot, withFolderPlugins } =
    await import("./start.js");
  let config: CraftConfig;
  try {
    config = await loadConfig(configPath);
    config = await withFolderPlugins(root, projectContentRoot(root), config);
  } catch (error: unknown) {
    throw new Error(
      `Failed to load ${displayPath(root, configPath)}: ${messageOf(error)}`,
      { cause: error },
    );
  }
  const { collectCredentialLogins, credentialsConfigOf, openCredentialStore } =
    await import("@routecraft/routecraft");
  const logins = collectCredentialLogins(config);
  const opened = await openCredentialStore(credentialsConfigOf(config));
  if (opened.backend === "memory") {
    await closeIf(opened);
    throw new Error(
      "The credential store is configured as memory, which a login cannot hand to the application. Point credentials.store at a file.",
    );
  }
  return {
    logins,
    store: opened.store,
    close: () => closeIf(opened),
  };
}

async function closeIf(opened: {
  store: CredentialStore;
  owned: boolean;
}): Promise<void> {
  if (opened.owned) await opened.store.close();
}

/** The logins a command acts on, or the reason there are none. */
function selectTargets(
  logins: readonly CredentialLogin[],
  client: string | undefined,
  all: boolean | undefined,
  exporting: boolean | undefined,
): CredentialLogin[] | string {
  if (logins.length === 0) {
    return "No client in craft.config.ts logs in. Declare one with auth: connect({ clientId }).";
  }
  if (client !== undefined) {
    if (all) return "Name a client or pass --all, not both.";
    const login = logins.find((each) => each.id === client);
    return login === undefined ? unknownClient(logins, client) : [login];
  }
  if (!all && !exporting) {
    return "Name a client to log in, or pass --all for every client that holds nothing.";
  }
  return [...logins];
}

function unknownClient(
  logins: readonly CredentialLogin[],
  client: string,
): string {
  const known = logins.map((each) => each.id).join(", ");
  return `No client named "${client}" logs in. ${known === "" ? "None does." : `Those that do: ${known}.`}`;
}

async function list(session: Session): Promise<CommandResult> {
  const lines: string[] = [];
  for (const login of session.logins) {
    const held = await session.store.get(login.owner);
    const state =
      held === undefined
        ? `not connected; run \`craft connect ${login.id}\``
        : `connected, logged in ${new Date(held.issuedAt).toISOString()}, last refreshed ${new Date(held.updatedAt).toISOString()}`;
    lines.push(`${login.id}  ${login.description}  ${state}`);
  }
  // Credentials no declared client claims any more, so they can be removed.
  const claimed = new Set(session.logins.map((login) => login.owner));
  for (const held of await session.store.list()) {
    if (claimed.has(held.owner)) continue;
    lines.push(
      `${held.owner}  no longer declared; remove with \`craft disconnect ${held.owner}\``,
    );
  }
  if (lines.length === 0) {
    return { code: 0, output: "No client in craft.config.ts logs in." };
  }
  return { code: 0, output: lines.join("\n") };
}

/** Run one login against a loopback listener for the redirect. */
async function runLogin(
  store: CredentialStore,
  login: CredentialLogin,
  options: ConnectOptions,
): Promise<void> {
  const listener = await listen(parsePort(options.port));
  try {
    const io: CredentialLoginIO = {
      redirectUrl: listener.redirectUrl,
      openUrl: async (url) => {
        const write = options.stderr ?? ((text) => process.stderr.write(text));
        write(`Log in to "${login.id}" at:\n\n  ${url.href}\n\n`);
        if (options.open !== false) openBrowser(url);
      },
      waitForCallback: () => listener.callback,
    };
    await login.login(store, io);
  } finally {
    await listener.close();
  }
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`--port must be a port number, got "${raw}".`);
  }
  return port;
}

interface Listener {
  redirectUrl: string;
  callback: Promise<URLSearchParams>;
  close(): Promise<void>;
}

/**
 * Listen on the loopback interface for the authorization server's redirect.
 * Bound to 127.0.0.1 alone, so nothing else on the network can deliver one.
 */
async function listen(port: number): Promise<Listener> {
  let settle!: (params: URLSearchParams) => void;
  let fail!: (error: Error) => void;
  const callback = new Promise<URLSearchParams>((done, refuse) => {
    settle = done;
    fail = refuse;
  });
  // Unhandled until the login waits on it; a timeout before then is
  // reported through the wait.
  callback.catch(() => undefined);
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end();
      return;
    }
    // Only an authorization response ends the wait: a stray request (a
    // favicon, a reload without the query) must not be taken for one.
    if (!url.searchParams.has("code") && !url.searchParams.has("error")) {
      response
        .writeHead(400, { "content-type": "text/plain; charset=utf-8" })
        .end("Not an authorization response.\n");
      return;
    }
    response
      .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      .end(
        url.searchParams.has("error")
          ? "The login was refused. Return to the terminal for the reason.\n"
          : "Login received. Return to the terminal to see whether it completed.\n",
      );
    settle(url.searchParams);
  });
  await new Promise<void>((done, refuse) => {
    server.once("error", refuse);
    server.listen(port, "127.0.0.1", () => done());
  });
  const address = server.address();
  const bound = typeof address === "object" && address ? address.port : port;
  const timer = setTimeout(() => {
    fail(
      new Error(
        `No login came back within ${CALLBACK_TIMEOUT_MS / 60_000} minutes; run craft connect again.`,
      ),
    );
  }, CALLBACK_TIMEOUT_MS);
  return {
    redirectUrl: `http://127.0.0.1:${bound}${CALLBACK_PATH}`,
    callback,
    close: () =>
      new Promise<void>((done) => {
        clearTimeout(timer);
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}

/**
 * Open a URL in the system browser, best effort: the URL is also printed.
 *
 * Never through a shell: the URL comes from the authorization server's
 * metadata, and `cmd /c start` would read its `&` as command separators.
 */
function openBrowser(url: URL): void {
  if (url.protocol !== "https:" && url.protocol !== "http:") return;
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url.href]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url.href]]
        : ["xdg-open", [url.href]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // No browser to open; the printed URL is the way in.
  }
}
