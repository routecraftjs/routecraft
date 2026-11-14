import type { Logger } from "../logger.ts";
import type { CredentialStore } from "./credentials.ts";

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
   * owner is refused (`RC5072`), and a listing shows only those owners. Opened on the
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
