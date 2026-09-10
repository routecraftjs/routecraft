import type { CraftContext, CraftPlugin } from "../context.ts";
import { registerConfigApplier } from "../config-applier.ts";
import { DEFERRAL_RUNTIME } from "./runtime-key.ts";
import { registerDeferralsResource } from "./ops-resource.ts";
import { MemoryDeferralStore } from "./memory-store.ts";
import {
  DEFAULT_DEFERRAL_DB_PATH,
  SqliteDeferralStore,
} from "./sqlite-store.ts";
import type { SqliteDriverLoaders } from "../shared/sqlite/driver.ts";
import { claimDatabasePath, releaseClaimant } from "../shared/sqlite/claims.ts";
import { rcError } from "../error.ts";
import {
  type ResumeTokenSigner,
  DEFERRAL_SECRET_ENV,
  resolveSigningSecret,
} from "./tokens.ts";
import type { DeferralStore } from "./types.ts";
import { type Duration, parseDuration } from "../shared/duration.ts";
import {
  DEFAULT_EXPIRY_LEASE,
  DEFAULT_DEFERRAL_RETENTION,
  DEFAULT_SWEEP_INTERVAL,
  DEFAULT_DEFERRAL_TTL,
  DeferralSweeper,
} from "./sweeper.ts";

/**
 * Environment variable naming where deferred exchanges are persisted. Either
 * a file path or the literal `memory`. Overridden by an explicit
 * `deferral: { store }`.
 */
export const DEFERRAL_STORE_ENV = "ROUTECRAFT_DEFERRAL_STORE";

/** The setting this store's path claim is reported under. */
const DEFERRAL_CLAIMANT = "deferral: { store }";

export { DEFERRAL_RUNTIME };

declare module "@routecraft/routecraft" {
  interface CraftConfig {
    /**
     * Durable defer and resume. Set it when any route can reach a
     * `.defer()`; leaving it unset is fine for a context that never
     * defers.
     */
    deferral?: DeferralConfig;
  }
}

/**
 * Where deferred exchanges live.
 *
 * - A path (or `{ path }`) opens the sqlite backend at that location. This
 *   is the value a container deployment sets to a mounted volume, which is
 *   the whole point of it being configurable.
 * - `"memory"` opts into the in-process backend explicitly, accepting that
 *   deferred exchanges die with the process.
 * - A {@link DeferralStore} instance plugs in a backend of your own
 *   (postgres, redis) without waiting for core to ship one.
 */
export type DeferralStoreConfig =
  string | { path: string } | "memory" | DeferralStore;

/**
 * Deferral configuration on `defineConfig`.
 */
export interface DeferralConfig {
  /**
   * Where deferred exchanges are persisted. Defaults to the sqlite backend at
   * {@link DEFAULT_DEFERRAL_DB_PATH}, or to whatever
   * {@link DEFERRAL_STORE_ENV} names.
   */
  store?: DeferralStoreConfig;
  /**
   * HMAC secret for signing resume tokens.
   *
   * Prefer the {@link DEFERRAL_SECRET_ENV} environment variable: a secret
   * in a config file is a secret in version control. This field exists for
   * deployments that pull secrets from a manager at boot and hand them to
   * `defineConfig` in code.
   */
  secret?: string;
  /**
   * How long a deferral stays resumable when `.defer()` names no `ttl`.
   *
   * Defaults to {@link DEFAULT_DEFERRAL_TTL}. Set `"never"` to opt a
   * context out of default expiry entirely, which means an unresumed
   * deferral is kept until something else retires it.
   */
  defaultTtl?: Duration | "never";
  /**
   * How often the sweeper looks for overdue deferrals.
   *
   * Defaults to {@link DEFAULT_SWEEP_INTERVAL}. TTLs are measured in hours,
   * so sub-minute precision buys nothing; the knob exists for tests and for
   * deployments that want expiry noticed sooner.
   */
  sweepInterval?: Duration;
  /**
   * How long an expiry-delivery claim is honoured before the sweeper
   * releases it for redelivery.
   *
   * Defaults to {@link DEFAULT_EXPIRY_LEASE}. Only a crash mid-delivery
   * ever spends this; keep it comfortably longer than the slowest `.error()`
   * handler, because a lease shorter than a slow handler would make one
   * healthy process double-deliver by itself.
   */
  expiryLease?: Duration;
  /**
   * How long settled deferrals (resumed, expired, denied) are kept before
   * the sweeper purges them.
   *
   * Defaults to {@link DEFAULT_DEFERRAL_RETENTION}. Set `"never"` to keep
   * everything, which is the audit-trail configuration; the store then
   * grows with every exchange that ever deferred.
   */
  retention?: Duration | "never";
}

/**
 * Seams the test harness needs and users must not have.
 *
 * Kept off {@link DeferralConfig} rather than tagged `@internal` on it,
 * because `allowEphemeralSecret` is a security relaxation: it short-circuits
 * the named-environment gate that `.standards/security.md` section 6a
 * requires, and `@internal` is a documentation tag, not an enforcement
 * mechanism. On the public config type it would be exactly the flag someone
 * copies out of a test fixture to make an RC5040 startup error go away.
 * `CraftConfig["deferral"]` is declared as `DeferralConfig` alone;
 * `@routecraft/testing` supplies these separately.
 *
 * @internal
 */
export interface DeferralTestSeams {
  /** Driver loader injection, for exercising the absent-peer arm. */
  loaders?: SqliteDriverLoaders;
  /**
   * Permit an ephemeral in-memory signing key when no secret is
   * configured, regardless of `NODE_ENV`.
   */
  allowEphemeralSecret?: boolean;
}

/**
 * The resolved per-context deferral runtime: one store, one signer.
 */
export interface DeferralRuntime {
  readonly store: DeferralStore;
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
  /**
   * Milliseconds a deferral stays resumable when `.defer()` names no
   * `ttl`. Undefined when the context opted out with `defaultTtl: "never"`,
   * which is the only way to defer something with no deadline at all.
   */
  readonly defaultTtlMs?: number;
  /**
   * Milliseconds between sweeps. Resolved here rather than in the plugin's
   * `start()` hook so a malformed duration fails while the context is still
   * being built, which is the rule the rest of this config already follows.
   */
  readonly sweepIntervalMs: number;
  /** Milliseconds an expiry-delivery claim is honoured before redelivery. */
  readonly expiryLeaseMs: number;
  /** Milliseconds settled records are kept. Undefined means keep forever. */
  readonly retentionMs?: number;
}

/**
 * Build the deferral runtime for a context.
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
 *   stop a context whose routes may never defer at all.
 *
 * @param context - Context whose logger reports the outcome.
 * @param config - The `deferral` config block, if any.
 *
 * @internal
 */
export async function createDeferralRuntime(
  context: CraftContext,
  config: DeferralConfig & DeferralTestSeams = {},
): Promise<DeferralRuntime> {
  const configuredTtl = config.defaultTtl ?? DEFAULT_DEFERRAL_TTL;
  const defaultTtlMs =
    configuredTtl === "never"
      ? undefined
      : parseDuration(configuredTtl, "deferral.defaultTtl");

  const sweepIntervalMs = parseDuration(
    config.sweepInterval ?? DEFAULT_SWEEP_INTERVAL,
    "deferral.sweepInterval",
  );
  const expiryLeaseMs = parseDuration(
    config.expiryLease ?? DEFAULT_EXPIRY_LEASE,
    "deferral.expiryLease",
  );
  const configuredRetention = config.retention ?? DEFAULT_DEFERRAL_RETENTION;
  const retentionMs =
    configuredRetention === "never"
      ? undefined
      : parseDuration(configuredRetention, "deferral.retention");

  const signer = resolveSigningSecret({
    ...(config.secret !== undefined ? { secret: config.secret } : {}),
    allowEphemeral: config.allowEphemeralSecret ?? isDevelopmentRuntime(),
  });
  if (signer.source === "ephemeral") {
    context.logger.warn(
      {},
      `Deferral resume tokens are signed with an ephemeral key. Tokens minted by this process become unverifiable when it restarts. Set ${DEFERRAL_SECRET_ENV} before deploying.`,
    );
  }

  /**
   * One shape for every exit. Four hand-written literals is how
   * `defaultTtlMs` came to be silently dropped on the sqlite branch, which
   * is the backend the production default uses.
   */
  const runtime = (
    store: DeferralStore,
    backend: DeferralRuntime["backend"],
    ownsStore: boolean,
  ): DeferralRuntime => ({
    store,
    signer,
    backend,
    ownsStore,
    sweepIntervalMs,
    expiryLeaseMs,
    ...(retentionMs !== undefined ? { retentionMs } : {}),
    ...(defaultTtlMs !== undefined ? { defaultTtlMs } : {}),
  });

  // A present-but-empty environment variable means unset, not "open the
  // working directory as a database". `resolveSigningSecret` treats a blank
  // secret the same way.
  const fromEnv = process.env[DEFERRAL_STORE_ENV]?.trim();
  const configured =
    config.store ??
    (fromEnv !== undefined && fromEnv !== "" ? fromEnv : undefined);
  const explicit = configured !== undefined;

  if (
    configured !== undefined &&
    typeof configured === "object" &&
    "create" in configured
  ) {
    releaseClaimant({ scope: context, claimant: DEFERRAL_CLAIMANT });
    return runtime(configured, "custom", false);
  }
  if (configured === "memory") {
    releaseClaimant({ scope: context, claimant: DEFERRAL_CLAIMANT });
    return runtime(new MemoryDeferralStore(), "memory", true);
  }

  const path =
    typeof configured === "object" && configured !== null
      ? configured.path
      : ((configured as string | undefined) ?? DEFAULT_DEFERRAL_DB_PATH);

  claimDatabasePath({
    scope: context,
    path,
    claimant: DEFERRAL_CLAIMANT,
    onConflict: (conflict) =>
      rcError("RC5044", undefined, {
        message: `deferral: { store } and ${conflict.held} both point at "${conflict.path}". Each store versions its own file, so they cannot share one; give them separate paths.`,
      }),
  });

  try {
    const store = await SqliteDeferralStore.open({
      path,
      ...(config.loaders ? { loaders: config.loaders } : {}),
    });
    context.logger.debug(
      { backend: "sqlite", driver: store.driver, path },
      "Deferral store opened",
    );
    return runtime(store, "sqlite", true);
  } catch (err) {
    if (explicit) throw err;
    // Nothing opened the file, so nothing may go on holding it: this
    // fallback is a deliberate degradation, and a claim left behind would
    // refuse the next store to ask for a path no store is using.
    releaseClaimant({ scope: context, claimant: DEFERRAL_CLAIMANT });
    context.logger.warn(
      { err, path },
      "No durable deferral store available; deferred exchanges will NOT survive a restart. Install better-sqlite3 (Node) or configure deferral: { store } to keep deferrals durable.",
    );
    return runtime(new MemoryDeferralStore(), "memory", true);
  }
}

/**
 * Plugin form of {@link createDeferralRuntime}, wired to the `deferral`
 * config key. Resolves the runtime during `initPlugins()` so a missing
 * signing secret fails at startup, and closes the store during teardown,
 * but only a store it opened itself.
 */
export function deferralPlugin(config: DeferralConfig = {}): CraftPlugin {
  // Keyed by context, not a plain closure variable: one plugin instance can
  // serve two contexts in the same process (a `defineConfig` export reused
  // across tests), and a single slot would let the second start overwrite
  // the first sweeper, leaving its interval running against a store that is
  // about to close.
  const sweepers = new WeakMap<CraftContext, DeferralSweeper>();

  return {
    name: "deferral",
    async apply(ctx: CraftContext) {
      ctx.setStore(DEFERRAL_RUNTIME, await createDeferralRuntime(ctx, config));
      registerDeferralsResource(ctx);
    },
    async start(ctx: CraftContext) {
      const runtime = ctx.getStore(DEFERRAL_RUNTIME);
      if (!runtime) return;
      const sweeper = new DeferralSweeper(ctx, runtime.store, {
        intervalMs: runtime.sweepIntervalMs,
        leaseMs: runtime.expiryLeaseMs,
        ...(runtime.retentionMs !== undefined
          ? { retentionMs: runtime.retentionMs }
          : {}),
      });
      sweepers.set(ctx, sweeper);
      // Before the interval, and awaited: what expired during the outage
      // reaches its routes ahead of anything new arriving.
      await sweeper.scanOnStart();
      sweeper.start();
    },
    async teardown(ctx: CraftContext) {
      // Awaited before the store closes; see DeferralSweeper.stop().
      await sweepers.get(ctx)?.stop();
      sweepers.delete(ctx);
      const runtime = ctx.getStore(DEFERRAL_RUNTIME);
      if (runtime?.ownsStore) await runtime.store.close();
    },
  };
}

registerConfigApplier("deferral", (options) => deferralPlugin(options));

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
