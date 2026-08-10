import type { CraftContext, CraftPlugin } from "../context.ts";
import { registerConfigApplier } from "../config-applier.ts";
import { SUSPENSION_RUNTIME } from "./runtime-key.ts";
import { MemorySuspensionStore } from "./memory-store.ts";
import {
  DEFAULT_SUSPENSION_DB_PATH,
  SqliteSuspensionStore,
} from "./sqlite-store.ts";
import type { SqliteDriverLoaders } from "./sqlite-driver.ts";
import {
  type ResumeTokenSigner,
  SUSPENSION_SECRET_ENV,
  resolveSigningSecret,
} from "./tokens.ts";
import type { SuspensionStore } from "./types.ts";

/**
 * Environment variable naming where parked exchanges are persisted. Either
 * a file path or the literal `memory`. Overridden by an explicit
 * `suspension: { store }`.
 */
export const SUSPENSION_STORE_ENV = "ROUTECRAFT_SUSPENSION_STORE";

export { SUSPENSION_RUNTIME };

declare module "@routecraft/routecraft" {
  interface CraftConfig {
    /**
     * Durable suspend and resume. Set it when any route can reach a
     * `.suspend()`; leaving it unset is fine for a context that never
     * suspends.
     */
    suspension?: SuspensionConfig;
  }
}

/**
 * Where parked exchanges live.
 *
 * - A path (or `{ path }`) opens the sqlite backend at that location. This
 *   is the value a container deployment sets to a mounted volume, which is
 *   the whole point of it being configurable.
 * - `"memory"` opts into the in-process backend explicitly, accepting that
 *   parked exchanges die with the process.
 * - A {@link SuspensionStore} instance plugs in a backend of your own
 *   (postgres, redis) without waiting for core to ship one.
 */
export type SuspensionStoreConfig =
  string | { path: string } | "memory" | SuspensionStore;

/**
 * Suspension configuration on `defineConfig`.
 */
export interface SuspensionConfig {
  /**
   * Where parked exchanges are persisted. Defaults to the sqlite backend at
   * {@link DEFAULT_SUSPENSION_DB_PATH}, or to whatever
   * {@link SUSPENSION_STORE_ENV} names.
   */
  store?: SuspensionStoreConfig;
  /**
   * HMAC secret for signing resume tokens.
   *
   * Prefer the {@link SUSPENSION_SECRET_ENV} environment variable: a secret
   * in a config file is a secret in version control. This field exists for
   * deployments that pull secrets from a manager at boot and hand them to
   * `defineConfig` in code.
   */
  secret?: string;
}

/**
 * Seams the test harness needs and users must not have.
 *
 * Kept off {@link SuspensionConfig} rather than tagged `@internal` on it,
 * because `allowEphemeralSecret` is a security relaxation: it short-circuits
 * the named-environment gate that `.standards/security.md` section 6a
 * requires, and `@internal` is a documentation tag, not an enforcement
 * mechanism. On the public config type it would be exactly the flag someone
 * copies out of a test fixture to make an RC5040 startup error go away.
 * `CraftConfig["suspension"]` is declared as `SuspensionConfig` alone;
 * `@routecraft/testing` supplies these separately.
 *
 * @internal
 */
export interface SuspensionTestSeams {
  /** Driver loader injection, for exercising the absent-peer arm. */
  loaders?: SqliteDriverLoaders;
  /**
   * Permit an ephemeral in-memory signing key when no secret is
   * configured, regardless of `NODE_ENV`.
   */
  allowEphemeralSecret?: boolean;
}

/**
 * The resolved per-context suspension runtime: one store, one signer.
 */
export interface SuspensionRuntime {
  readonly store: SuspensionStore;
  readonly signer: ResumeTokenSigner;
  /**
   * What the store resolved to, for the startup log line. `custom` is a
   * store the caller supplied; reporting it as `sqlite` would mislead
   * exactly the operators who configured a backend deliberately, on the one
   * field that answers "is this deployment durable, and against what".
   */
  readonly backend: "sqlite" | "memory" | "custom";
  /**
   * False when the caller supplied the store, in which case they own its
   * lifecycle and the plugin must not close it on teardown. A user-supplied
   * backend typically wraps a pool shared with the rest of the application,
   * or is reused across two contexts in one process (which is how a
   * restart-durability test is written).
   */
  readonly ownsStore: boolean;
}

/**
 * Build the suspension runtime for a context.
 *
 * The durability decision happens here, once, and it is deliberately loud
 * in the degraded case. A deployment that asked for a durable store and did
 * not get one has lost the feature's entire promise, so:
 *
 * - An explicitly configured path that cannot be opened FAILS. Silently
 *   degrading a deployment that named a volume would turn "we survive
 *   restarts" into "we lost the approvals" with no signal.
 * - An unconfigured context that cannot open the default path falls back to
 *   memory with a `warn` line naming the reason, because the most likely
 *   cause is a Node install without `better-sqlite3`, and that should not
 *   stop a context whose routes may never suspend at all.
 *
 * @param context - Context whose logger reports the outcome.
 * @param config - The `suspension` config block, if any.
 *
 * @internal
 */
export async function createSuspensionRuntime(
  context: CraftContext,
  config: SuspensionConfig & SuspensionTestSeams = {},
): Promise<SuspensionRuntime> {
  const signer = resolveSigningSecret({
    ...(config.secret !== undefined ? { secret: config.secret } : {}),
    allowEphemeral: config.allowEphemeralSecret ?? isDevelopmentRuntime(),
  });
  if (signer.source === "ephemeral") {
    context.logger.warn(
      {},
      `Suspension resume tokens are signed with an ephemeral key. Tokens minted by this process become unverifiable when it restarts. Set ${SUSPENSION_SECRET_ENV} before deploying.`,
    );
  }

  // A present-but-empty environment variable means unset, not "open the
  // working directory as a database". `resolveSigningSecret` treats a blank
  // secret the same way.
  const fromEnv = process.env[SUSPENSION_STORE_ENV]?.trim();
  const configured =
    config.store ??
    (fromEnv !== undefined && fromEnv !== "" ? fromEnv : undefined);
  const explicit = configured !== undefined;

  if (
    configured !== undefined &&
    typeof configured === "object" &&
    "create" in configured
  ) {
    return { store: configured, signer, backend: "custom", ownsStore: false };
  }
  if (configured === "memory") {
    return {
      store: new MemorySuspensionStore(),
      signer,
      backend: "memory",
      ownsStore: true,
    };
  }

  const path =
    typeof configured === "object" && configured !== null
      ? configured.path
      : ((configured as string | undefined) ?? DEFAULT_SUSPENSION_DB_PATH);

  try {
    const store = await SqliteSuspensionStore.open({
      path,
      ...(config.loaders ? { loaders: config.loaders } : {}),
    });
    context.logger.debug(
      { backend: "sqlite", driver: store.driver, path },
      "Suspension store opened",
    );
    return { store, signer, backend: "sqlite", ownsStore: true };
  } catch (err) {
    if (explicit) throw err;
    context.logger.warn(
      { err, path },
      "No durable suspension store available; parked exchanges will NOT survive a restart. Install better-sqlite3 (Node) or configure suspension: { store } to keep suspensions durable.",
    );
    return {
      store: new MemorySuspensionStore(),
      signer,
      backend: "memory",
      ownsStore: true,
    };
  }
}

/**
 * Plugin form of {@link createSuspensionRuntime}, wired to the `suspension`
 * config key. Resolves the runtime during `initPlugins()` so a missing
 * signing secret fails at startup, and closes the store during teardown,
 * but only a store it opened itself.
 */
export function suspensionPlugin(config: SuspensionConfig = {}): CraftPlugin {
  return {
    name: "suspension",
    async apply(ctx: CraftContext) {
      ctx.setStore(
        SUSPENSION_RUNTIME,
        await createSuspensionRuntime(ctx, config),
      );
    },
    async teardown(ctx: CraftContext) {
      const runtime = ctx.getStore(SUSPENSION_RUNTIME);
      if (runtime?.ownsStore) await runtime.store.close();
    },
  };
}

registerConfigApplier("suspension", (options) => suspensionPlugin(options));

/**
 * Whether the process is running a named development or test environment.
 *
 * Deliberately an allowlist rather than `NODE_ENV !== "production"`: an
 * unset `NODE_ENV` is the most common production misconfiguration, and
 * under the negated form it would silently enable ephemeral signing keys on
 * a real deployment. Per `.standards/security.md` section 6a, the relaxed
 * mode is the one that has to be named.
 *
 * @internal
 */
function isDevelopmentRuntime(): boolean {
  const env = process.env["NODE_ENV"];
  return env === "development" || env === "test";
}
