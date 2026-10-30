import type { CraftConfig } from "@routecraft/routecraft";
import { rcError } from "../../error.ts";
import type { CredentialStore } from "./types.ts";

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
 * A credential a person obtains by logging in, declared in configuration.
 * Ecosystem packages contribute these through
 * {@link registerCredentialLogins}, so the CLI can run every login without
 * knowing the protocol behind it.
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

/** Finds the logins a configuration declares. */
export type CredentialLoginCollector = (
  config: CraftConfig,
) => readonly CredentialLogin[];

/** Shared across copies of the package, like the config-applier registry. */
const REGISTRY_KEY: unique symbol = Symbol.for(
  "routecraft.credential-login-collectors",
);

type GlobalWithRegistry = typeof globalThis & {
  [REGISTRY_KEY]?: Map<string, CredentialLoginCollector>;
};

function registry(): Map<string, CredentialLoginCollector> {
  const g = globalThis as GlobalWithRegistry;
  g[REGISTRY_KEY] ??= new Map();
  return g[REGISTRY_KEY];
}

/**
 * Contribute the logins a package's configuration declares. Called once at
 * module load, beside the package's config applier, under a name of its own
 * so a second copy of the package replaces rather than duplicates.
 */
export function registerCredentialLogins(
  name: string,
  collect: CredentialLoginCollector,
): void {
  registry().set(name, collect);
}

/**
 * Every login a configuration declares, in registration order.
 *
 * @throws when two packages declare one id, which `craft connect <id>`
 *   could not tell apart
 */
export function collectCredentialLogins(
  config: CraftConfig,
): CredentialLogin[] {
  const logins: CredentialLogin[] = [];
  const ids = new Set<string>();
  for (const collect of registry().values()) {
    for (const login of collect(config)) {
      if (ids.has(login.id)) {
        throw rcError("RC5003", undefined, {
          message: `Two logins are named "${login.id}"; give the clients distinct names.`,
        });
      }
      ids.add(login.id);
      logins.push(login);
    }
  }
  return logins;
}
