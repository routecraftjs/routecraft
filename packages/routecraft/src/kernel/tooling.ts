import type { Logger } from "../logger.ts";

/**
 * A credential as the store holds it: an opaque JSON value with the version
 * a compare-and-swap writes against.
 */
export interface StoredCredential {
  /** What the owner stored. The store never reads inside it. */
  readonly value: unknown;
  /**
   * Bumped by every write. A writer passes the version it read as
   * `ifVersion`, so two writers racing on one owner cannot both win.
   */
  readonly version: number;
  /**
   * When the credential was obtained by a person (a `craft connect`), in
   * epoch milliseconds. Carried unchanged through refreshes, so an imported
   * seed replaces a stored credential only when a later login produced it.
   */
  readonly issuedAt: number;
  /** When the record was last written, in epoch milliseconds. */
  readonly updatedAt: number;
}

/** What a compare-and-swap write reports. */
export type CredentialWrite =
  | { readonly written: true; readonly version: number }
  | {
      readonly written: false;
      /** What the store holds instead, or undefined when the owner is gone. */
      readonly current: StoredCredential | undefined;
    };

/**
 * Where upstream credentials live, by owner.
 *
 * An owner names the thing a credential authenticates, such as `mcp:billing`
 * for the named MCP client `billing`. One owner holds one credential.
 *
 * `put` is a compare-and-swap, and `delete` is one when given `ifVersion`,
 * so a process holding a stale credential cannot write it over a newer one:
 * the loser's write is refused, and it reads what the winner stored. It does
 * not stop two processes sending the same refresh token; a server that
 * rotates refresh tokens refuses the later one, and that process then reads
 * the winner's. Versions count from 1 again after a delete.
 */
export interface CredentialStore {
  /** The credential an owner holds, or undefined. */
  get(owner: string): Promise<StoredCredential | undefined>;
  /**
   * Write an owner's credential when the store still holds `ifVersion`:
   * `null` writes only when the owner holds nothing yet.
   *
   * @param value - A JSON value: the SQLite store keeps it as JSON, so a
   *   `Date`, `Map` or class instance does not come back as written
   *
   * @param options.issuedAt - When a person obtained it; defaults to the
   *   stored value's, or now for a first write
   */
  put(
    owner: string,
    value: unknown,
    options: { readonly ifVersion: number | null; readonly issuedAt?: number },
  ): Promise<CredentialWrite>;
  /**
   * Remove an owner's credential, only while it still holds `ifVersion`
   * when one is given.
   *
   * @returns Whether a record was removed
   */
  delete(
    owner: string,
    options?: { readonly ifVersion?: number },
  ): Promise<boolean>;
  /** Every owner and its credential. */
  list(): Promise<Array<StoredCredential & { readonly owner: string }>>;
  /** Release the store's handle. */
  close(): Promise<void>;
}

/**
 * What a login needs from whoever runs it: somewhere for the authorization
 * server to send the person back to, and a way to show them where to go.
 * `craft connect` supplies a loopback listener and the system browser.
 */
export interface CredentialLoginIO {
  /** Where the authorization server redirects once the person consents. */
  readonly redirectUrl: string;
  /** Send the person to the authorization URL. */
  openUrl(url: URL): Promise<void>;
  /** The query of the redirect, once the person comes back. */
  waitForCallback(): Promise<URLSearchParams>;
}

/**
 * A credential a person obtains by logging in. A plugin declares its logins
 * in {@link PluginTooling.logins}, so `craft connect` can run every login
 * without knowing the protocol behind it.
 */
export interface CredentialLogin {
  /** The name `craft connect <id>` takes: the client's configured name. */
  readonly id: string;
  /** The store owner the credential is kept under. */
  readonly owner: string;
  /** What is logged into, for a listing. */
  readonly description: string;
  /**
   * Run the login and write the credential to `store`.
   *
   * @throws when the person declines, the callback does not match the
   *   request, or the authorization server refuses the code
   */
  login(store: CredentialStore, io: CredentialLoginIO): Promise<void>;
}

/** What a tooling command is handed when it runs. */
export interface ToolingContext {
  /** The project root: the directory holding `craft.config.ts`. */
  readonly root: string;
  /** The project's logger. A command's result goes in its return value, not here. */
  readonly logger: Logger;
  /**
   * The project's credential store, narrowed to the owners this plugin's
   * own {@link PluginTooling.logins} declare. Reading or writing any other
   * owner is refused, and a listing shows only those owners. Opened on the
   * first call; the caller closes it.
   */
  credentials(): Promise<CredentialStore>;
}

/** What a tooling command prints and the code the process exits with. */
export interface ToolingResult {
  /** The exit code; 0 is success. */
  readonly code: number;
  /** Printed on standard output. */
  readonly output?: string;
  /** Printed on standard error. */
  readonly error?: string;
}

/** One command a plugin adds to the command line. */
export interface ToolingCommand {
  /** One line saying what the command does, for a listing. */
  readonly summary: string;
  /** The arguments it takes, as shown after the command's name in help. */
  readonly usage?: string;
  /**
   * Run the command. It runs outside any application: nothing is bound or
   * started, so it works from the plugin's own options.
   *
   * @param args - The command line after the command's name
   * @param context - The project root, its logger and this plugin's credentials
   */
  run(args: readonly string[], context: ToolingContext): Promise<ToolingResult>;
}

/**
 * What a plugin gives the tools around an application, read from the
 * project's resolved plugin list without binding anything.
 */
export interface PluginTooling {
  /**
   * `craft <namespace> <key>`, the namespace being the plugin's own.
   * Namespaces are unique per application (`RC1102`). The command line
   * refuses a namespace equal to one of its own verbs, and a key that
   * duplicates a subcommand it ships under that namespace (`RC1117`).
   */
  readonly commands?: Readonly<Record<string, ToolingCommand>>;
  /**
   * The logins this plugin's configuration declares, for `craft connect`.
   * Pure: called by every tool that reads them, never by the application.
   */
  readonly logins?: () => readonly CredentialLogin[];
}
