import { registerShippedPlugin } from "../../kernel/defaults.ts";
import {
  definePlugin,
  type Plugin,
  type PluginContext,
  type PluginLogger,
} from "../../kernel/plugin.ts";
import { deferralOf, type Exchange } from "../../exchange.ts";
import type { DeferralAffordance } from "../../kernel/continuation/exchange-state.ts";
import { deferralSteps } from "./steps.ts";
import { registerConfigApplier } from "../../config-applier.ts";
import {
  CONTINUATIONS,
  type DeferralRuntime,
} from "../../kernel/continuation/port.ts";
import { registerDeferralsResource } from "./ops-resource.ts";
import { OPS } from "../ops/store.ts";
import { MemoryDeferralStore } from "./memory-store.ts";
import {
  DEFAULT_DEFERRAL_DB_PATH,
  SqliteDeferralStore,
} from "./sqlite-store.ts";
import type { SqliteDriverLoaders } from "../../shared/sqlite/driver.ts";
import {
  claimDatabasePath,
  releaseClaimant,
} from "../../shared/sqlite/claims.ts";
import { rcError } from "../../error.ts";
import { DEFERRAL_SECRET_ENV, resolveSigningSecret } from "./tokens.ts";
import type { DeferralStore } from "../../kernel/continuation/types.ts";
import { type Duration, parseDuration } from "../../shared/duration.ts";
import {
  DEFAULT_EXPIRY_LEASE,
  DEFAULT_DEFERRAL_RETENTION,
  DEFAULT_SWEEP_INTERVAL,
  DEFAULT_DEFERRAL_TTL,
} from "../../kernel/continuation/sweep.ts";
import { isDevelopmentRuntime } from "../../shared/runtime-env.ts";
import { SweepCadence } from "./cadence.ts";

/**
 * Environment variable naming where deferred exchanges are persisted. Either
 * a file path or the literal `memory`. Overridden by an explicit
 * `deferral: { store }`.
 */
export const DEFERRAL_STORE_ENV = "ROUTECRAFT_DEFERRAL_STORE";

/** The setting this store's path claim is reported under. */
const DEFERRAL_CLAIMANT = "deferral: { store }";

export { CONTINUATIONS, type DeferralRuntime };

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
 * @param host - Whose logger reports the outcome, and the scope a store's
 *   file claim is held under: the plugin context, or a context in a test
 * @param config - The `deferral` config block, if any.
 *
 * @internal
 */
export async function createDeferralRuntime(
  host: { readonly logger: PluginLogger },
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
    host.logger.warn(
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
    path?: string,
  ): DeferralRuntime => ({
    store,
    signer,
    backend,
    ownsStore,
    sweepIntervalMs,
    expiryLeaseMs,
    ...(retentionMs !== undefined ? { retentionMs } : {}),
    ...(defaultTtlMs !== undefined ? { defaultTtlMs } : {}),
    ...(path !== undefined ? { path } : {}),
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
    releaseClaimant({ scope: host, claimant: DEFERRAL_CLAIMANT });
    return runtime(configured, "custom", false);
  }
  if (configured === "memory") {
    releaseClaimant({ scope: host, claimant: DEFERRAL_CLAIMANT });
    return runtime(new MemoryDeferralStore(), "memory", true);
  }

  const path =
    typeof configured === "object" && configured !== null
      ? configured.path
      : ((configured as string | undefined) ?? DEFAULT_DEFERRAL_DB_PATH);

  claimDatabasePath({
    scope: host,
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
    host.logger.debug(
      { backend: "sqlite", driver: store.driver, path },
      "Deferral store opened",
    );
    return runtime(store, "sqlite", true, path);
  } catch (err) {
    if (explicit) throw err;
    // Nothing opened the file, so nothing may go on holding it: this
    // fallback is a deliberate degradation, and a claim left behind would
    // refuse the next store to ask for a path no store is using.
    releaseClaimant({ scope: host, claimant: DEFERRAL_CLAIMANT });
    host.logger.warn(
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
export function deferralPlugin(config: DeferralConfig = {}): DeferralPlugin {
  // Keyed by the plugin context, not a closure slot: one descriptor can serve
  // two applications in the same process (a `defineConfig` export reused
  // across tests), and a single slot would let the second start overwrite the
  // first cadence, leaving its interval running against a store about to close.
  const runs = new WeakMap<
    PluginContext,
    { runtime: DeferralRuntime; cadence?: SweepCadence }
  >();

  return definePlugin({
    id: "routecraft.deferral",
    provides: [CONTINUATIONS],
    optional: [OPS],
    steps: deferralSteps,
    facet: deferralOf,
    async bind(c: PluginContext) {
      // Registration first: it throws on a name collision, and a bind that
      // throws after opening the store would leave its handle to the unwind.
      registerDeferralsResource(c, () => runs.get(c)?.runtime);
      const runtime = await createDeferralRuntime(c, config);
      runs.set(c, { runtime });
      c.provide(CONTINUATIONS, runtime);
    },
    async start(c: PluginContext) {
      const run = runs.get(c);
      if (!run) return;
      // Before the interval, and awaited: what expired during the outage
      // reaches its routes ahead of anything new arriving.
      await c.execution.sweep({ boot: true });
      run.cadence = new SweepCadence(
        () => c.execution.sweep(),
        run.runtime.sweepIntervalMs,
        c.logger,
      );
      run.cadence.start();
    },
    async stop(c: PluginContext) {
      const run = runs.get(c);
      if (!run) return;
      runs.delete(c);
      // Awaited before the store closes, so no pass meets a closed handle.
      await run.cadence?.stop();
      if (run.runtime.ownsStore) await run.runtime.store.close();
    },
  });
}

registerShippedPlugin(() => deferralPlugin());

/**
 * The deferral plugin's descriptor type, for typing a project's routes.
 * Declared rather than inferred from {@link deferralPlugin}, so typing a
 * route never depends on the plugin's implementation.
 */
export interface DeferralPlugin extends Plugin {
  readonly id: "routecraft.deferral";
  readonly steps: typeof deferralSteps;
  readonly facet: (exchange: Exchange) => DeferralAffordance;
}

registerConfigApplier("deferral", (options) => deferralPlugin(options));
