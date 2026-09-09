/**
 * Public types for the remotes plugin.
 *
 * A remote is another running instance whose dispatchable routes become
 * direct endpoints here. The options are deliberately small: an address,
 * a credential for that instance's door, and two cadences. Everything
 * about what the remote exposes is the remote's own configuration, read
 * through its ops management API, and nothing here restates it.
 */

import type { Duration } from "../../shared/duration.ts";
import type { OpsBearerToken } from "../ops/client.ts";

/** One remote instance, keyed by name in `defineConfig({ remotes })`. */
export interface RemoteDefinition {
  /**
   * The instance's base URL, the origin its ops surface is mounted on.
   * A bearer travels over plain `http:` only to a loopback address, for
   * the same reason the CLI refuses it: every hop in between can read it.
   */
  url: string;
  /**
   * Credential for the remote's door. Read from the environment, as a
   * string or as a function evaluated per request so a rotated token is
   * picked up without a restart. The identity the remote sees is whatever
   * its own validator mints from it; this plugin makes no call on api keys
   * versus JWTs.
   */
  auth?: {
    token?: OpsBearerToken;
  };
  /** Per-request deadline against the remote. Defaults to `"30s"`. */
  timeout?: Duration;
  /**
   * How often the inventory is re-read. Defaults to `"60s"`; `false`
   * disables the interval, leaving the boot read and the refresh a
   * dispatch forces when it meets a 404 for a route the inventory still
   * lists.
   */
  refresh?: Duration | false;
}

/**
 * The `remotes` config key: remotes by name.
 *
 * Git-style naming. The routes of `default` are advertised bare, exactly
 * as a local route would be, so `direct('hello')` and `Direct(hello)` reach
 * them with nothing to learn; every other remote's routes are qualified
 * `name:id`, and `default:id` names the default remote explicitly. Two
 * remotes therefore never collide, and a local route with the same id as
 * a default-remote route shadows it: the local one answers, the remote
 * stays reachable as `default:id`, and the overlap is logged as a warning
 * rather than refused, because it is the window in which a capability is
 * being promoted from a laptop to the server.
 */
export type RemotesConfig = Record<string, RemoteDefinition>;

/** Options for {@link remotesPlugin}; the same shape as the config key. */
export type RemotesPluginOptions = RemotesConfig;
