import { loadOptionalPeer } from "@routecraft/routecraft";

/**
 * Optional peer loading for the shell adapter.
 *
 * Both packages are declared optional peers and imported through
 * `loadOptionalPeer`, so an absent one surfaces as `RC5017` naming the
 * package and the install command rather than a raw module-resolution
 * failure. Kept in its own module so the tiers and the execution path can
 * each reach a peer without importing one another.
 */

type ExecaModule = typeof import("execa");
type ShescapeModule = typeof import("shescape");

let execaCache: Promise<ExecaModule> | undefined;
let shescapeCache: Promise<ShescapeModule> | undefined;

/** Load `execa`, the subprocess runner. */
export function loadExeca(): Promise<ExecaModule> {
  execaCache ??= loadOptionalPeer(() => import("execa"), {
    consumer: "shell adapter",
    packageName: "execa",
  });
  return execaCache;
}

/** Load `shescape`, which provides the argument hygiene. */
export function loadShescape(): Promise<ShescapeModule> {
  shescapeCache ??= loadOptionalPeer(() => import("shescape"), {
    consumer: "shell adapter",
    packageName: "shescape",
  });
  return shescapeCache;
}
