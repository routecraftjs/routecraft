import { registerShippedPlugin } from "../../kernel/defaults.ts";
import {
  definePlugin,
  type Plugin,
  type PluginContext,
  type PluginLogger,
} from "../../kernel/plugin.ts";
import { registerConfigApplier } from "../../config-applier.ts";
import type { SqliteDriverLoaders } from "../../shared/sqlite/driver.ts";
import { MemoryCredentialStore } from "./memory-store.ts";
import { sealerFromEnv } from "./seal.ts";
import {
  CREDENTIALS_SEED_ENV,
  decodeCredentialSeed,
  importCredentialSeed,
} from "./seed.ts";
import {
  DEFAULT_CREDENTIALS_DB_PATH,
  SqliteCredentialStore,
} from "./sqlite-store.ts";
import {
  CREDENTIALS,
  type CredentialStore,
  type CredentialWrite,
  type StoredCredential,
} from "./types.ts";

/**
 * Environment variable naming where credentials are kept: a file path or
 * the literal `memory`. Overridden by an explicit `credentials: { store }`.
 */
export const CREDENTIALS_STORE_ENV = "ROUTECRAFT_CREDENTIALS_STORE";

declare module "@routecraft/routecraft" {
  interface CraftConfig {
    /**
     * Where credentials for upstreams are kept: the tokens a
     * `craft connect` login obtains for a named client, refreshed in place.
     */
    credentials?: CredentialsConfig;
  }
}

/**
 * Where credentials live.
 *
 * - A path (or `{ path }`) opens the SQLite store there. A container sets
 *   it to a mounted volume, so a refreshed token survives a redeploy.
 * - `"memory"` keeps them in the process, lost on restart.
 * - A {@link CredentialStore} plugs in a backend of your own.
 */
export type CredentialStoreConfig =
  string | { path: string } | "memory" | CredentialStore;

/** Credentials configuration on `defineConfig`. */
export interface CredentialsConfig {
  /**
   * Defaults to the SQLite store at {@link DEFAULT_CREDENTIALS_DB_PATH}, or
   * to whatever {@link CREDENTIALS_STORE_ENV} names.
   */
  store?: CredentialStoreConfig;
}

/** @internal */
interface CredentialsTestSeams {
  loaders?: SqliteDriverLoaders;
  env?: NodeJS.ProcessEnv;
}

/**
 * Open the store a configuration names, sealing with
 * `ROUTECRAFT_CREDENTIALS_KEY` when it is set. `craft connect` opens the
 * store with this, so a login writes where the application reads.
 *
 * @returns The store, and whether the caller owns (and must close) it
 * @throws RC5017 under Node without `better-sqlite3`
 * @throws RC5070 when the file cannot be opened as a credential store
 */
export async function openCredentialStore(
  config: CredentialsConfig & CredentialsTestSeams = {},
): Promise<{
  store: CredentialStore;
  owned: boolean;
  backend: "sqlite" | "memory" | "custom";
  path?: string;
}> {
  const env = config.env ?? process.env;
  const fromEnv = env[CREDENTIALS_STORE_ENV]?.trim();
  const configured =
    config.store ??
    (fromEnv !== undefined && fromEnv !== "" ? fromEnv : undefined);
  if (typeof configured === "object" && "get" in configured) {
    return { store: configured, owned: false, backend: "custom" };
  }
  if (configured === "memory") {
    return {
      store: new MemoryCredentialStore(),
      owned: true,
      backend: "memory",
    };
  }
  const path =
    typeof configured === "object"
      ? configured.path
      : (configured ?? DEFAULT_CREDENTIALS_DB_PATH);
  const store = await SqliteCredentialStore.open({
    path,
    sealer: sealerFromEnv(env),
    ...(config.loaders ? { loaders: config.loaders } : {}),
  });
  return { store, owned: true, backend: "sqlite", path };
}

/**
 * A store opened on first use, so an application with no client that needs
 * a credential never creates the file.
 */
class LazyCredentialStore implements CredentialStore {
  #opening: Promise<CredentialStore> | undefined;
  #owned = false;

  constructor(
    private readonly config: CredentialsConfig & CredentialsTestSeams,
    private readonly logger: PluginLogger,
  ) {}

  #store(): Promise<CredentialStore> {
    this.#opening ??= this.#open();
    return this.#opening;
  }

  async #open(): Promise<CredentialStore> {
    const explicit =
      this.config.store !== undefined ||
      (this.config.env ?? process.env)[CREDENTIALS_STORE_ENV] !== undefined;
    try {
      const opened = await openCredentialStore(this.config);
      this.#owned = opened.owned;
      this.logger.debug(
        { backend: opened.backend, path: opened.path },
        "Credential store opened",
      );
      return opened.store;
    } catch (err) {
      // A configured store that cannot open fails; the default falls back,
      // because the likely cause is Node without better-sqlite3 and a login
      // then lasts until the process stops rather than failing outright.
      if (explicit || !isMissingDriver(err)) throw err;
      this.logger.warn(
        { err },
        "No durable credential store available; credentials will NOT survive a restart. Install better-sqlite3 (Node) or configure credentials: { store }.",
      );
      this.#owned = true;
      return new MemoryCredentialStore();
    }
  }

  async get(owner: string): Promise<StoredCredential | undefined> {
    return (await this.#store()).get(owner);
  }
  async put(
    owner: string,
    value: unknown,
    options: { readonly ifVersion: number | null; readonly issuedAt?: number },
  ): Promise<CredentialWrite> {
    return (await this.#store()).put(owner, value, options);
  }
  async delete(
    owner: string,
    options?: { readonly ifVersion?: number },
  ): Promise<boolean> {
    return (await this.#store()).delete(owner, options);
  }
  async list(): Promise<Array<StoredCredential & { readonly owner: string }>> {
    return (await this.#store()).list();
  }
  async close(): Promise<void> {
    const opening = this.#opening;
    this.#opening = undefined;
    if (opening === undefined) return;
    const store = await opening.catch(() => undefined);
    if (store && this.#owned) await store.close();
  }
}

function isMissingDriver(err: unknown): boolean {
  return (err as { rc?: unknown } | null)?.rc === "RC5017";
}

/**
 * The credentials plugin: provides {@link CREDENTIALS}, the store every named
 * client that logs in keeps its credential in.
 *
 * Installed by default. The store opens on first use, except when
 * `ROUTECRAFT_CREDENTIALS_SEED` is set: then it opens at bind and imports
 * the seed, so a server's first call already finds the credential.
 */
export function credentialsPlugin(
  config: CredentialsConfig & CredentialsTestSeams = {},
): Plugin {
  return definePlugin({
    id: "routecraft.credentials",
    provides: [CREDENTIALS],
    async bind(c: PluginContext) {
      const store = new LazyCredentialStore(config, c.logger);
      // Released with the application, without a `stop` hook: a default
      // plugin that most applications never use adds no lifecycle events.
      c.onDispose(() => store.close());
      c.provide(CREDENTIALS, store);
      const env = config.env ?? process.env;
      const seed = env[CREDENTIALS_SEED_ENV]?.trim();
      if (seed === undefined || seed === "") return;
      const entries = decodeCredentialSeed(seed, sealerFromEnv(env));
      const { imported, kept } = await importCredentialSeed(store, entries);
      c.logger.info(
        { imported, kept },
        imported.length > 0
          ? "Imported credentials from the seed"
          : "Credential seed holds nothing newer than the store",
      );
    },
  });
}

registerShippedPlugin(() => credentialsPlugin(), { default: true });
registerConfigApplier("credentials", (options) => credentialsPlugin(options));
