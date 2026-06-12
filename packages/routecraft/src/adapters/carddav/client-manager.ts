/**
 * CardDAV client manager: one logged-in DAV client per named account.
 *
 * Created by the ContextBuilder when `carddav` config is present. Adapters get
 * it from the context store and request a client by account name. The
 * underlying tsdav client is HTTP/stateless, so there are no sockets to pool;
 * the manager simply caches the logged-in client (login is the only async cost).
 *
 * @experimental
 */

import { rcError } from "../../error.ts";
import { loadOptionalPeer } from "../shared/optional-peer.ts";
import type { CarddavContextConfig } from "./types.ts";
import {
  DEFAULT_CARDDAV_SERVER_URL,
  throwCarddavError,
  type CarddavDriverClient,
} from "./shared.ts";

/** Connection inputs resolved from account + context config. */
export interface ResolvedCarddavConnection {
  serverUrl: string;
  username: string;
  password: string;
}

/**
 * Manages per-account logged-in CardDAV clients.
 *
 * @experimental
 */
export class CarddavClientManager {
  /**
   * Login seam. Resolves a driver client for the given connection. Exposed as a
   * static so tests can substitute a fake client without a network round-trip
   * (mirrors the cron adapter's `loadDriver` pattern).
   * @internal
   */
  static createDriverClient: (
    connection: ResolvedCarddavConnection,
  ) => Promise<CarddavDriverClient> = async (connection) => {
    const tsdav = await loadOptionalPeer(() => import("tsdav"), {
      adapterName: "carddav",
      packageName: "tsdav",
    });
    const client = await tsdav.createDAVClient({
      serverUrl: connection.serverUrl,
      credentials: {
        username: connection.username,
        password: connection.password,
      },
      authMethod: "Basic",
      defaultAccountType: "carddav",
    });
    return client as unknown as CarddavDriverClient;
  };

  private readonly clients = new Map<string, Promise<CarddavDriverClient>>();
  readonly config: CarddavContextConfig;
  readonly defaultAccount: string;

  constructor(config: CarddavContextConfig) {
    this.config = config;
    const accounts = config.accounts ?? {};
    this.defaultAccount =
      "default" in accounts ? "default" : (Object.keys(accounts)[0] ?? "");
  }

  /** Resolve the connection inputs for an account, throwing RC5003 if incomplete. */
  resolveConnection(account?: string): ResolvedCarddavConnection {
    const name = account ?? this.defaultAccount;
    const acct = this.config.accounts?.[name];
    if (!acct) {
      throw rcError("RC5003", undefined, {
        message: `CardDAV account '${name || "(none)"}' is not configured.`,
      });
    }
    if (!acct.username || !acct.appPassword) {
      throw rcError("RC5003", undefined, {
        message: `CardDAV account '${name}' requires both username and appPassword.`,
      });
    }
    return {
      serverUrl:
        acct.serverUrl ?? this.config.serverUrl ?? DEFAULT_CARDDAV_SERVER_URL,
      username: acct.username,
      password: acct.appPassword,
    };
  }

  /** The default address book display name for an account, if configured. */
  resolveAddressBookName(account?: string): string | undefined {
    const name = account ?? this.defaultAccount;
    return this.config.accounts?.[name]?.addressBook ?? this.config.addressBook;
  }

  /** Acquire (and cache) a logged-in client for the given account. */
  async getClient(account?: string): Promise<CarddavDriverClient> {
    const name = account ?? this.defaultAccount;
    let pending = this.clients.get(name);
    if (!pending) {
      const connection = this.resolveConnection(name);
      pending = CarddavClientManager.createDriverClient(connection).catch(
        (error: unknown) => {
          // Drop the rejected promise so a later call can retry the login.
          this.clients.delete(name);
          throwCarddavError(error, "login");
        },
      );
      this.clients.set(name, pending);
    }
    return pending;
  }

  /**
   * Release cached clients. Called during context teardown. Awaits any logins
   * still in flight (via `allSettled`) so a slow login that rejects after the
   * map has been cleared does not surface as an `unhandledRejection`.
   */
  async drain(): Promise<void> {
    const pending = Array.from(this.clients.values());
    this.clients.clear();
    await Promise.allSettled(pending);
  }
}
