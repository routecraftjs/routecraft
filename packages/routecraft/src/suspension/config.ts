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
import { type Duration, parseDuration } from "./duration.ts";
import { DEFAULT_AUTHORIZE_TIMEOUT } from "./answerer.ts";
import {
  DEFAULT_EXPIRY_LEASE,
  DEFAULT_SUSPENSION_RETENTION,
  DEFAULT_SWEEP_INTERVAL,
  DEFAULT_SUSPENSION_TTL,
  SuspensionSweeper,
} from "./sweeper.ts";

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
  /**
   * How long a suspension stays resumable when `.suspend()` names no `ttl`.
   *
   * Defaults to {@link DEFAULT_SUSPENSION_TTL}. Set `"never"` to opt a
   * context out of default expiry entirely, which means an unanswered
   * suspension is kept until something else retires it.
   */
  defaultTtl?: Duration | "never";
  /**
   * How often the sweeper looks for overdue suspensions.
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
   * How long a `.suspend({ authorize })` predicate may run before it is
   * refused.
   *
   * Defaults to {@link DEFAULT_AUTHORIZE_TIMEOUT}. The predicate sits inside
   * the pre-claim window, where the suspension's own deadline can elapse and
   * the sweeper can take an expiry claim, so it is bounded rather than left
   * to a user callback. Raise it only if a predicate genuinely has to make a
   * network call, which is a design smell worth removing instead: the
   * answerer's claims were already resolved by the ingress route's
   * `.authenticate()`.
   */
  authorizeTimeout?: Duration;
  /**
   * How long settled suspensions (resumed, expired, denied) are kept before
   * the sweeper purges them.
   *
   * Defaults to {@link DEFAULT_SUSPENSION_RETENTION}. Set `"never"` to keep
   * everything, which is the audit-trail configuration; the store then
   * grows with every exchange that ever suspended.
   */
  retention?: Duration | "never";
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
  /**
   * Milliseconds a suspension stays resumable when `.suspend()` names no
   * `ttl`. Undefined when the context opted out with `defaultTtl: "never"`,
   * which is the only way to park something with no deadline at all.
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
  /** Milliseconds an `authorize()` predicate may run before it is refused. */
  readonly authorizeTimeoutMs: number;
  /** Milliseconds settled records are kept. Undefined means keep forever. */
  readonly retentionMs?: number;
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
  const configuredTtl = config.defaultTtl ?? DEFAULT_SUSPENSION_TTL;
  const defaultTtlMs =
    configuredTtl === "never"
      ? undefined
      : parseDuration(configuredTtl, "suspension.defaultTtl");

  const sweepIntervalMs = parseDuration(
    config.sweepInterval ?? DEFAULT_SWEEP_INTERVAL,
    "suspension.sweepInterval",
  );
  const expiryLeaseMs = parseDuration(
    config.expiryLease ?? DEFAULT_EXPIRY_LEASE,
    "suspension.expiryLease",
  );
  const authorizeTimeoutMs = parseDuration(
    config.authorizeTimeout ?? DEFAULT_AUTHORIZE_TIMEOUT,
    "suspension.authorizeTimeout",
  );
  const configuredRetention = config.retention ?? DEFAULT_SUSPENSION_RETENTION;
  const retentionMs =
    configuredRetention === "never"
      ? undefined
      : parseDuration(configuredRetention, "suspension.retention");

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

  /**
   * One shape for every exit. Four hand-written literals is how
   * `defaultTtlMs` came to be silently dropped on the sqlite branch, which
   * is the backend the production default uses.
   */
  const runtime = (
    store: SuspensionStore,
    backend: SuspensionRuntime["backend"],
    ownsStore: boolean,
  ): SuspensionRuntime => ({
    store,
    signer,
    backend,
    ownsStore,
    sweepIntervalMs,
    expiryLeaseMs,
    authorizeTimeoutMs,
    ...(retentionMs !== undefined ? { retentionMs } : {}),
    ...(defaultTtlMs !== undefined ? { defaultTtlMs } : {}),
  });

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
    return runtime(configured, "custom", false);
  }
  if (configured === "memory") {
    return runtime(new MemorySuspensionStore(), "memory", true);
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
    return runtime(store, "sqlite", true);
  } catch (err) {
    if (explicit) throw err;
    context.logger.warn(
      { err, path },
      "No durable suspension store available; parked exchanges will NOT survive a restart. Install better-sqlite3 (Node) or configure suspension: { store } to keep suspensions durable.",
    );
    return runtime(new MemorySuspensionStore(), "memory", true);
  }
}

/**
 * Plugin form of {@link createSuspensionRuntime}, wired to the `suspension`
 * config key. Resolves the runtime during `initPlugins()` so a missing
 * signing secret fails at startup, and closes the store during teardown,
 * but only a store it opened itself.
 */
export function suspensionPlugin(config: SuspensionConfig = {}): CraftPlugin {
  // Keyed by context, not a plain closure variable: one plugin instance can
  // serve two contexts in the same process (a `defineConfig` export reused
  // across tests), and a single slot would let the second start overwrite
  // the first sweeper, leaving its interval running against a store that is
  // about to close.
  const sweepers = new WeakMap<CraftContext, SuspensionSweeper>();

  return {
    name: "suspension",
    async apply(ctx: CraftContext) {
      ctx.setStore(
        SUSPENSION_RUNTIME,
        await createSuspensionRuntime(ctx, config),
      );
    },
    async start(ctx: CraftContext) {
      const runtime = ctx.getStore(SUSPENSION_RUNTIME);
      if (!runtime) return;
      const sweeper = new SuspensionSweeper(ctx, runtime.store, {
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
      // Awaited before the store closes; see SuspensionSweeper.stop().
      await sweepers.get(ctx)?.stop();
      sweepers.delete(ctx);
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
