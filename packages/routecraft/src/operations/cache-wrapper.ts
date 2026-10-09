import { createHash, randomUUID } from "node:crypto";
import { type Duration, parseDuration } from "../shared/duration.ts";
import {
  type Exchange,
  DefaultExchange,
  isDropped,
  markDropped,
  principalOf,
  HeadersKeys,
} from "../exchange.ts";
import { wrapperEventScope } from "./event-scope.ts";
import { rcError } from "../error.ts";
import { isRoutecraftError } from "../brand.ts";
import { hashExchangeBody } from "./hash-body.ts";
import { principalIdentity } from "./principal-identity.ts";
import type { Adapter, Step, StepContext, StepOutcome } from "../types.ts";
import type { RouteDefinition } from "../route.ts";
import { WrapperStep, type RequiredPosition } from "./wrapper.ts";
import { nestedStepsOf } from "../kernel/continuation/sites.ts";
import {
  definitionFingerprint,
  stepDefinitionFingerprint,
} from "../kernel/continuation/hash.ts";
import {
  type CacheProvider,
  defaultMemoryCacheProvider,
} from "./cache-provider.ts";
import { positionFor } from "./position-run.ts";
import { CACHE } from "../kernel/positions.ts";
import type { CacheStep } from "../kernel/positions.ts";

/**
 * Options for `.cache()`, at route scope (before `.from()`) and step scope
 * (after `.from()`).
 *
 * @template Current Body type entering the cached route or step.
 */
export interface CacheOptions<Current = unknown> {
  /**
   * Derive the cache key from the exchange. The returned string is the
   * identity used by the provider's `get` / `set`.
   *
   * When omitted, the key is a SHA-256 over the route id (plus, at step
   * scope, the cache's site, and at route scope, a fingerprint of the
   * cached pipeline: see `CacheKeyScope`), the principal's
   * `issuer` and `subject` plus those of every `actor` hop when the
   * exchange carries one, and a SHA-256 of `JSON.stringify(body)`. Two routes, two cached steps, or two
   * callers therefore never share an entry by accident. The route id is
   * part of the key, so give the route an `.id()`: an unnamed route gets
   * a fresh id on every start, and its entries in an external provider
   * stop matching after a restart.
   *
   * The default needs a body. An exchange whose body is `undefined` (a
   * bodiless `http()` GET, whose input lives in the
   * `routecraft.http.params` / `routecraft.http.query` headers) fails
   * with `RC5029`, as does a body `JSON.stringify` cannot represent
   * (a top-level function or symbol, a circular reference, a `BigInt`).
   * Nested functions and symbols are silently dropped by `JSON.stringify`,
   * so bodies differing only there share a key. Supply `key` for those. A
   * `null` body is keyable.
   *
   * A custom `key` is used VERBATIM: nothing is added to it. Every route
   * and step on the same provider shares entries for equal keys, and so
   * does every caller, so put the route (`ex.headers[HeadersKeys.ROUTE_ID]`)
   * and the caller's identity (`principalOf(ex)?.issuer` and `subject`)
   * in the key, and drop the principal only when every caller sees the same
   * answer. On a route that admits delegation, add the current actor
   * (`principalOf(ex)?.actor?.issuer` and `subject`) as well, or two
   * delegates acting for the same subject share entries.
   *
   * Performance: the default hashes a JSON serialisation of the body on
   * every exchange. For hot paths or large bodies (file contents, large
   * payloads), supply a `key` that returns a stable identifier already
   * to hand (an id field, a content hash in a header, a tuple of the
   * relevant fields) to avoid re-serialising and re-hashing.
   */
  key?: (exchange: Exchange<Current>) => string;
  /**
   * Time to live. After expiry, the next execution with the same key
   * recomputes the value. When omitted, the provider's default applies
   * (the bundled in-memory provider keeps entries until LRU eviction).
   */
  ttl?: Duration;
  /**
   * Cache backend. Defaults to a process-wide in-memory provider. Pass
   * a custom provider (Redis, multi-tier, file-backed, etc.) by
   * constructing an implementation of {@link CacheProvider} and
   * handing it in here.
   */
  provider?: CacheProvider;
}

/**
 * Where a cache sits, which the default key namespaces its entries by.
 *
 * `site` is the JSON of `[index, stackIndex, below, fingerprint]`: the
 * step's pre-order index in the route's step tree, the cache's index in
 * that step's full wrapper stack, `[kind, optionsFingerprint]` for each
 * wrapper between the cache and the innermost step, and a fingerprint of
 * the innermost step's definition (operation, label, adapter id and
 * options, callable source). It derives from the route definition alone,
 * so every process running the same route source computes the same site
 * and shares entries in an external provider. Moving a step, reordering
 * its wrappers, or changing its definition or the options of a wrapper
 * below the cache (an `.error()` handler, a `.retry()` policy) changes the
 * site, so those edits cause misses rather than replays of entries the old
 * definition produced.
 *
 * Wrappers above the cache contribute their count (through `stackIndex`)
 * but not their options: they run outside the cached computation and none
 * rewrites the exchange it passes inward, so they cannot change what is
 * stored for a key. The fingerprints do not cover what a callable closes
 * over or config read at run time; put those in an explicit key when they
 * change the output.
 *
 * At route scope there is no site; `pipeline` is the
 * {@link pipelineFingerprint} of every step a hit skips, nested branches
 * and wrapper options included, so editing any of them misses rather than
 * replaying what the old pipeline produced. The route's `.input()` and
 * `.output()` schemas stay out: input validation runs before the cache
 * check (its result is the body the key hashes) and output validation runs
 * after the pipeline on a hit as on a miss, so neither shapes a stored
 * entry.
 *
 * @internal
 */
export type CacheKeyScope =
  | {
      readonly kind: "route";
      readonly routeId: string;
      readonly pipeline: string;
    }
  | { readonly kind: "step"; readonly routeId: string; readonly site: string };

/**
 * {@link CacheOptions} with every field populated, defaults filled in: what
 * a `CACHE` provider receives, at route scope and at step scope alike.
 */
export interface ResolvedCacheOptions<Current = unknown> {
  key: (exchange: Exchange<Current>, scope: CacheKeyScope) => string;
  /** No custom `key` was supplied, so `key` is {@link defaultCacheKey}. */
  usesDefaultKey: boolean;
  ttl: number | undefined;
  provider: CacheProvider;
}

/**
 * Resolve a user-supplied {@link CacheOptions} into a fully populated
 * {@link ResolvedCacheOptions}, filling defaults: {@link defaultCacheKey}
 * for `key`, no TTL, and the module-level in-memory provider. A custom
 * `key` ignores the scope.
 *
 * @internal
 */
export function resolveCacheOptions<Current = unknown>(
  options: CacheOptions<Current> = {},
): ResolvedCacheOptions<Current> {
  const custom = options.key;
  return {
    key: custom ? (exchange) => custom(exchange) : defaultCacheKey,
    usesDefaultKey: custom === undefined,
    ttl:
      options.ttl === undefined
        ? undefined
        : parseDuration(options.ttl, "cache({ ttl })"),
    provider: options.provider ?? defaultMemoryCacheProvider,
  };
}

/**
 * The default cache key: a SHA-256 over the JSON tuple
 * `[scope.kind, routeId, site | pipeline, principalChain | null, bodyHash]`,
 * where `principalChain` is `[issuer | null, subject]` for the principal
 * and each `actor` hop.
 * Encoding the tuple as JSON keeps the fields from running into each
 * other; hashing the body first keeps a large body out of the second
 * serialisation.
 *
 * @throws RC5029 when the body is `undefined` (nothing to key on) or is
 *   not JSON-serialisable.
 * @internal
 */
export function defaultCacheKey(
  exchange: Exchange<unknown>,
  scope: CacheKeyScope,
): string {
  if (exchange.body === undefined) {
    throw rcError("RC5029", undefined, {
      message:
        `Default cache key for route "${scope.routeId}" has nothing to key on: the exchange body is undefined. ` +
        "A bodiless request such as an http() GET carries its input in the routecraft.http.params and " +
        "routecraft.http.query headers, which the default key does not read. Supply a key, e.g. " +
        "cache({ key: (ex) => JSON.stringify([ex.headers['routecraft.route'], principalOf(ex)?.issuer, " +
        "principalOf(ex)?.subject, ex.headers['routecraft.http.params'], ex.headers['routecraft.http.query']]) }). " +
        "A custom key is used verbatim: drop the principal only when every caller sees the same answer, " +
        "and on a route that admits delegation add each principalOf(ex)?.actor hop as well.",
    });
  }
  let bodyHash: string;
  try {
    bodyHash = hashExchangeBody(exchange.body);
  } catch (err) {
    throw rcError("RC5029", err, {
      message:
        "Default cache key derivation failed: the exchange body is not JSON-serialisable. " +
        "Supply an explicit `key` function in cache({ key: ... }).",
    });
  }
  const identity = JSON.stringify([
    scope.kind,
    scope.routeId,
    scope.kind === "step" ? scope.site : scope.pipeline,
    principalIdentity(principalOf(exchange)),
    bodyHash,
  ]);
  return createHash("sha256").update(identity).digest("hex");
}

/**
 * Give every step-scope cache in a finalised route its
 * {@link CacheKeyScope} site. Runs from `RouteBuilder.build()`, walking the
 * step tree in pre-order and looking through wrapper stacks, so a cache
 * inside a `.choice()` branch or under an outer `.retry()` is found too.
 *
 * @returns Whether any step-scope cache in the route uses the default key.
 * @internal
 */
export function assignCacheSites(route: RouteDefinition): boolean {
  let next = 0;
  let usesDefaultKey = false;
  const visit = (steps: ReadonlyArray<Step<Adapter>>): void => {
    for (const step of steps) {
      const position = next++;
      const { stack, innermost } = unwrapStack(step);
      const fingerprint = stepDefinitionFingerprint(innermost);
      stack.forEach((wrapper, index) => {
        if (!(wrapper instanceof CacheWrapperStep)) return;
        const below = stack.slice(index + 1).map(wrapperIdentity);
        wrapper.assignSite(
          JSON.stringify([position, index, below, fingerprint]),
        );
        usesDefaultKey ||= wrapper.usesDefaultKey;
      });
      for (const nested of nestedStepsOf(step)) visit(nested.steps);
    }
  };
  visit(route.steps);
  return usesDefaultKey;
}

/**
 * Fingerprint of a whole pipeline, which a route-scope cache folds into
 * its default key because a hit skips every step in it. Each step
 * contributes `[kind, optionsFingerprint]` for every wrapper in its stack,
 * the innermost step's definition fingerprint, and, for every nested
 * sub-pipeline, the fingerprint of the predicate selecting it (a
 * `.choice()` branch) and the nested pipeline's own description. Derived
 * from the definition alone, so every process running the same route
 * source computes the same digest.
 *
 * @internal
 */
export function pipelineFingerprint(
  steps: ReadonlyArray<Step<Adapter>>,
): string {
  return createHash("sha256")
    .update(JSON.stringify(describePipeline(steps)))
    .digest("hex");
}

function describePipeline(steps: ReadonlyArray<Step<Adapter>>): unknown[] {
  return steps.map((step) => {
    const { stack, innermost } = unwrapStack(step);
    return [
      stack.map(wrapperIdentity),
      stepDefinitionFingerprint(innermost),
      nestedStepsOf(step).map((nested) => [
        nested.predicate === undefined
          ? null
          : definitionFingerprint(nested.predicate),
        describePipeline(nested.steps),
      ]),
    ];
  });
}

/** A step's wrapper stack, outermost first, and the step it folds around. */
function unwrapStack(step: Step<Adapter>): {
  stack: WrapperStep<Adapter>[];
  innermost: Step<Adapter>;
} {
  const stack: WrapperStep<Adapter>[] = [];
  let innermost: Step<Adapter> = step;
  while (innermost instanceof WrapperStep) {
    stack.push(innermost);
    innermost = innermost.wrapped;
  }
  return { stack, innermost };
}

function wrapperIdentity(wrapper: WrapperStep<Adapter>): [string, string] {
  return [
    wrapper.constructor.name,
    definitionFingerprint(wrapper.fingerprintOptions),
  ];
}

/**
 * Sentinel error thrown by the cache loader when the wrapped step
 * dropped the exchange (filter rejection, halt, etc.). Used to abort
 * the provider's `getOrCompute` so nothing is written to the cache,
 * while letting concurrent waiters observe the drop and mark their
 * own exchanges accordingly. Internal; never escapes the wrapper.
 */
class CacheLoaderDrop extends Error {
  constructor() {
    super("routecraft.cache.drop");
    this.name = "CacheLoaderDrop";
  }
}

/**
 * Step-scope `.cache()` wrapper. On a cache hit, replaces
 * `exchange.body` with the cached value and skips the wrapped step. On
 * a miss, runs the wrapped step, caches its produced body, and lets
 * the pipeline continue normally. Errors from the wrapped step are
 * NOT cached and propagate to outer wrappers / route-level handlers; an
 * error reply the step returns without throwing is cached (see
 * `StepBuilderBase.cache`).
 *
 * The default key is namespaced by route id and by this wrapper's site
 * ({@link CacheKeyScope}), assigned by {@link assignCacheSites} when the
 * route is built. A wrapper
 * that never went through `RouteBuilder.build()` (constructed by hand)
 * gets a random site on first use, so it never shares entries with
 * another cache, at the cost of not sharing them across restarts either.
 *
 * Concurrent exchanges with the same derived key share a single
 * computation via the provider's `getOrCompute`, so a slow underlying
 * operation runs at most once per key per TTL window.
 *
 * Emits cache lifecycle events on the route's event bus:
 * - `route:cache:hit` when a cached value is reused.
 * - `route:cache:miss` when the wrapped step runs.
 * - `route:cache:stored` when a fresh value is written.
 * - `route:cache:failed` when key derivation or the provider throws.
 *
 * Known limitation: concurrent exchanges that share a single
 * `getOrCompute` computation (stampede dedupe) currently report
 * `route:cache:hit` for the waiters rather than a distinct "deduped" signal,
 * which can inflate hit-rate metrics. Tracked separately; needs a
 * provider-interface change to report whether the current call ran the
 * loader.
 *
 * Ordering note: a step-scope `.error()` placed INSIDE the cache
 * (`.cache().error(h).to(d)`) feeds the handler's recovery value into
 * the cache, so a fallback becomes the permanent cached answer for that
 * key. Put `.error()` OUTSIDE the cache (`.error(h).cache().to(d)`)
 * unless caching recovery results is intended.
 *
 * Route scope (`.cache()` before `.from()`) does not use this class; it
 * runs as the `cacheCheck` / `cacheStore` filter steps.
 */
export class CacheWrapperStep<
  T extends Adapter = Adapter,
> extends WrapperStep<T> {
  readonly #options: ResolvedCacheOptions;
  // The resolved `key` wraps a custom key in one adapter lambda whose
  // source is the same for every cache, so fingerprint the original.
  readonly #customKey: CacheOptions["key"];
  #site: string | undefined;
  readonly #runs = new WeakMap<object, CacheStep>();

  constructor(inner: Step<T>, options: CacheOptions = {}) {
    super(inner);
    this.#options = resolveCacheOptions(options);
    this.#customKey = options.key;
  }

  protected override describeOptions(): unknown {
    return { key: this.#customKey ?? null, ttl: this.#options.ttl ?? null };
  }

  /**
   * Whether this cache derives its key with {@link defaultCacheKey}, which
   * depends on the route id.
   *
   * @internal
   */
  get usesDefaultKey(): boolean {
    return this.#options.usesDefaultKey;
  }

  override get requiredPosition(): RequiredPosition {
    return { port: CACHE, method: "cache" };
  }

  /**
   * Record this wrapper's position in its route. Called by
   * {@link assignCacheSites}; see {@link CacheKeyScope}.
   *
   * @internal
   */
  assignSite(site: string): void {
    this.#site = site;
  }

  protected override async runInner(
    exchange: Exchange,
    ctx: StepContext,
  ): Promise<StepOutcome> {
    const { context, routeId, stepLabel, correlationId } = wrapperEventScope(
      exchange,
      this,
    );
    const site = (this.#site ??= `unbuilt:${randomUUID()}`);

    let key: string;
    try {
      key = this.#options.key(exchange, { kind: "step", routeId, site });
    } catch (err) {
      context?.emit("route:cache:failed", {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        stepLabel,
        scope: "step",
        phase: "key",
        error: err instanceof Error ? err.message : String(err),
      });
      throw isRoutecraftError(err)
        ? err
        : rcError("RC5029", err, {
            message: `cache({ key }) for "${stepLabel}" threw while deriving the cache key`,
          });
    }

    const cache = positionFor(
      this.#runs,
      exchange,
      this,
      CACHE,
      "cache",
      (provider) => provider.wrap(this.#options),
    );
    return cache.run({
      routeId,
      scope: "step",
      stepLabel,
      exchange,
      key,
      emit: (event, details) => context?.emit(event, details),
      attempt: () => this.inner.execute(exchange, ctx),
    });
  }
}

/**
 * The framework's step-scope cache: what fills `CachePositions.wrap` unless
 * an installed plugin replaces `CACHE`. One `getOrCompute` per key, so a
 * stampede computes once and every waiter gets the value; a drop inside the
 * loader caches nothing and drops every waiter; a fan-out, branch or defer
 * outcome is refused, since the cache replays a single output.
 *
 * @internal
 */
export function cacheStepRun(options: ResolvedCacheOptions): CacheStep {
  return {
    async run(run) {
      const { exchange, key, routeId, stepLabel, scope } = run;
      const correlationId = exchange.headers[
        HeadersKeys.CORRELATION_ID
      ] as string;
      const scoped = {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        stepLabel,
        scope,
      };

      let ranInner = false;
      // Flips true once the inner step has produced its value inside the
      // loader, so the catch below tells an inner-step failure (loader not
      // yet resolved) from a provider write failure (loader resolved,
      // `getOrCompute` rejected while caching).
      let loaderResolved = false;
      // Set only by the call that runs the loader (the cache miss). On a hit
      // or stampede-dedup this stays undefined and the current exchange is
      // rewrapped with the cached body instead.
      let producedExchange: Exchange | undefined;
      let computed: unknown;

      try {
        computed = await options.provider.getOrCompute(
          key,
          async () => {
            ranInner = true;
            const outcome = await run.attempt();
            // A genuine drop is signalled by the drop outcome, never by an
            // undefined body: `transform(() => undefined)` is a value.
            if (outcome.kind === "drop" || isDropped(exchange)) {
              throw new CacheLoaderDrop();
            }
            if (
              outcome.kind === "fanOut" ||
              outcome.kind === "branch" ||
              outcome.kind === "defer"
            ) {
              throw rcError("RC5003", undefined, {
                message:
                  `.cache() cannot wrap "${stepLabel}": the step produced a "${outcome.kind}" ` +
                  `outcome, but cache replays a single output. Wrap a single-output step instead.`,
              });
            }
            producedExchange = outcome.exchange;
            loaderResolved = true;
            return outcome.exchange.body;
          },
          options.ttl,
        );
      } catch (err) {
        if (err instanceof CacheLoaderDrop) {
          // Mark this exchange (it may be a waiter whose own inner never
          // ran) so the template's empty-queue branch forwards a drop.
          markDropped(exchange);
          run.emit("route:cache:miss", { ...scoped, key, dropped: true });
          return { kind: "drop" };
        }
        // `"get"`: the provider read threw before the inner ran; `"inner"`:
        // the wrapped step threw; `"set"`: the inner succeeded and the
        // provider write threw.
        const phase = !ranInner ? "get" : loaderResolved ? "set" : "inner";
        run.emit("route:cache:failed", {
          ...scoped,
          phase,
          key,
          error: err instanceof Error ? err.message : String(err),
        });
        // Inner-step failures propagate unchanged so route-level handlers
        // see the real cause. Provider read and write failures map to the
        // retryable RC5028 unless the provider already threw a RoutecraftError.
        if (phase !== "inner" && !isRoutecraftError(err)) {
          throw rcError("RC5028", err, {
            message: `cache() provider ${phase === "get" ? "read" : "write"} failed for "${stepLabel}"`,
          });
        }
        throw err;
      }

      run.emit(ranInner ? "route:cache:miss" : "route:cache:hit", {
        ...scoped,
        key,
      });
      if (ranInner) {
        run.emit("route:cache:stored", {
          ...scoped,
          key,
          ...(options.ttl !== undefined ? { ttl: options.ttl } : {}),
        });
      }

      // On a miss this call ran the inner, so its produced exchange carries
      // its header writes and body. On a hit or stampede-dedup the inner did
      // not run for THIS exchange, so the current exchange is rewrapped with
      // the cached body: the wrapped step's side effects did not happen.
      const forwarded =
        ranInner && producedExchange !== undefined
          ? producedExchange
          : DefaultExchange.rewrap(exchange, { body: computed });
      return { kind: "continue", exchange: forwarded };
    },
  };
}
