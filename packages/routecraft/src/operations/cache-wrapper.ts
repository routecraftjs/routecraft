import { createHash, randomUUID } from "node:crypto";
import { type Duration, parseDuration } from "../shared/duration.ts";
import {
  type Exchange,
  DefaultExchange,
  isDropped,
  markDropped,
} from "../exchange.ts";
import { wrapperEventScope } from "./event-scope.ts";
import { rcError } from "../error.ts";
import { isRoutecraftError } from "../brand.ts";
import { hashExchangeBody } from "./hash-body.ts";
import type { Adapter, Step, StepContext, StepOutcome } from "../types.ts";
import type { RouteDefinition } from "../route.ts";
import { WrapperStep } from "./wrapper.ts";
import { nestedStepsOf } from "../deferral/sites.ts";
import {
  type CacheProvider,
  defaultMemoryCacheProvider,
} from "./cache-provider.ts";

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
   * When omitted, the key is a SHA-256 over the route id (and, at step
   * scope, the wrapped step's position in the route), the principal's
   * `issuer` and `subject` when the exchange carries one, and a SHA-256
   * of `JSON.stringify(body)`. Two routes, two cached steps, or two
   * callers therefore never share an entry by accident. The route id is
   * part of the key, so give the route an `.id()`: an unnamed route gets
   * a fresh id on every start, and its entries in an external provider
   * stop matching after a restart.
   *
   * The default needs a body. An exchange whose body is `undefined` (a
   * bodiless `http()` GET, whose input lives in the
   * `routecraft.http.params` / `routecraft.http.query` headers) fails
   * with `RC5029`, as does a body `JSON.stringify` cannot represent
   * (functions, symbols, circular references, `BigInt`). Supply `key` for
   * those. A `null` body is keyable.
   *
   * A custom `key` is used VERBATIM: nothing is added to it. Every route
   * and step on the same provider shares entries for equal keys, and so
   * does every caller, so put the route and the caller's identity
   * (`ex.principal?.subject`) in the key whenever the response depends on
   * them.
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
 * `site` is the wrapped step's position in a pre-order walk of the route's
 * step tree (the numbering `.defer()` sites use), then the cache's index
 * within that step's wrapper stack. It derives from the route definition
 * alone, so every process running the same route source computes the same
 * site and shares entries in an external provider. Editing the route above
 * a cached step shifts the site, which costs one miss per key.
 *
 * @internal
 */
export type CacheKeyScope =
  | { readonly kind: "route"; readonly routeId: string }
  | { readonly kind: "step"; readonly routeId: string; readonly site: string };

/**
 * Internal resolved shape of {@link CacheOptions}: every field is
 * populated, with defaults filled in. Shared between the step-scope
 * wrapper and the route-scope filter steps.
 *
 * @internal
 */
export interface ResolvedCacheOptions<Current = unknown> {
  key: (exchange: Exchange<Current>, scope: CacheKeyScope) => string;
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
    ttl:
      options.ttl === undefined
        ? undefined
        : parseDuration(options.ttl, "cache({ ttl })"),
    provider: options.provider ?? defaultMemoryCacheProvider,
  };
}

/**
 * The default cache key: a SHA-256 over the JSON tuple
 * `[scope.kind, routeId, site | null, [issuer | null, subject] | null, bodyHash]`.
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
        "cache({ key: (ex) => `order:${JSON.stringify(ex.headers['routecraft.http.params'])}` }). " +
        "A custom key is used verbatim, so include the caller's identity in it when responses differ per caller.",
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
  const principal = exchange.principal;
  const identity = JSON.stringify([
    scope.kind,
    scope.routeId,
    scope.kind === "step" ? scope.site : null,
    principal ? [principal.issuer ?? null, principal.subject] : null,
    bodyHash,
  ]);
  return createHash("sha256").update(identity).digest("hex");
}

/**
 * Give every step-scope cache in a finalised route its
 * {@link CacheKeyScope} site. Runs from `RouteBuilder.build()`, walking the
 * step tree in the same pre-order as the defer-site walk and looking through
 * wrapper stacks, so a cache inside a `.choice()` branch or under an outer
 * `.retry()` is found too.
 *
 * @internal
 */
export function assignCacheSites(route: RouteDefinition): void {
  let next = 0;
  const visit = (steps: ReadonlyArray<Step<Adapter>>): void => {
    for (const step of steps) {
      const position = next++;
      let depth = 0;
      for (
        let current: Step<Adapter> = step;
        current instanceof WrapperStep;
        current = current.wrapped
      ) {
        if (current instanceof CacheWrapperStep) {
          current.assignSite(`${position}.${depth++}`);
        }
      }
      for (const nested of nestedStepsOf(step)) visit(nested.steps);
    }
  };
  visit(route.steps);
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
 * NOT cached and propagate to outer wrappers / route-level handlers.
 * Whatever the wrapped step returns without throwing IS cached, so an
 * error reply returned as a value (an `http()` enricher with
 * `throwOnHttpError: false` answering 503) becomes the cached answer.
 *
 * The default key is namespaced by route id and by this wrapper's site,
 * assigned by {@link assignCacheSites} when the route is built. A wrapper
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
  #site: string | undefined;

  constructor(inner: Step<T>, options: CacheOptions = {}) {
    super(inner);
    this.#options = resolveCacheOptions(options);
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
    const { route, context, routeId, stepLabel, correlationId } =
      wrapperEventScope(exchange, this);
    const shouldEmit = route && context && routeId;
    const site = (this.#site ??= `unbuilt:${randomUUID()}`);

    let key: string;
    try {
      key = this.#options.key(exchange, { kind: "step", routeId, site });
    } catch (err) {
      if (shouldEmit) {
        context.emit("route:cache:failed", {
          routeId,
          exchangeId: exchange.id,
          correlationId,
          stepLabel,
          scope: "step",
          phase: "key",
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw isRoutecraftError(err)
        ? err
        : rcError("RC5029", err, {
            message: `cache({ key }) for "${stepLabel}" threw while deriving the cache key`,
          });
    }

    let ranInner = false;
    // Flips true once the inner step has produced its value inside the
    // loader. Lets the catch below tell an inner-step failure (loader
    // not yet resolved) from a provider write failure (loader resolved,
    // `getOrCompute` rejected while caching).
    let loaderResolved = false;
    // Set only by the call that runs the loader (the cache miss). On a
    // hit or stampede-dedup this stays undefined and the wrapper rewraps
    // the current exchange with the cached body instead.
    let producedExchange: Exchange | undefined;
    let computed: unknown;

    try {
      computed = await this.#options.provider.getOrCompute(
        key,
        async () => {
          ranInner = true;
          const outcome = await this.inner.execute(exchange, ctx);
          // A genuine drop is signalled by the drop outcome (filter
          // reject / halt), NOT by an undefined body: a step such as
          // `transform(() => undefined)` legitimately sets the body to
          // undefined and must not be misread as a drop.
          if (outcome.kind === "drop" || isDropped(exchange)) {
            // Abort via sentinel so `getOrCompute` writes nothing.
            throw new CacheLoaderDrop();
          }
          if (
            outcome.kind === "fanOut" ||
            outcome.kind === "branch" ||
            outcome.kind === "defer"
          ) {
            // The wrapper caches and replays a single output. Fan-out
            // would lose all but one child; a branch outcome carries
            // live steps that cannot be cached; a defer exchange is
            // mid-flight and must never be cache-stored. split / aggregate
            // are already blocked at construction by WrapperStep; this
            // guards choice and custom steps explicitly (the
            // pre-outcome engine silently discarded a wrapped choice's
            // branch steps instead).
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
        this.#options.ttl,
      );
    } catch (err) {
      if (err instanceof CacheLoaderDrop) {
        // Mark this exchange (may be a concurrent waiter whose own
        // inner never ran) so the template's empty-queue branch
        // forwards a drop, not a live exchange.
        markDropped(exchange);
        if (shouldEmit) {
          context.emit("route:cache:miss", {
            routeId,
            exchangeId: exchange.id,
            correlationId,
            stepLabel,
            scope: "step",
            key,
            dropped: true,
          });
        }
        return { kind: "drop" };
      }
      // Attribute the failure:
      // - `"get"`   provider read threw before the inner ran.
      // - `"inner"` the wrapped step itself threw (loader not resolved).
      // - `"set"`   the inner succeeded but the provider write threw.
      const phase = !ranInner ? "get" : loaderResolved ? "set" : "inner";
      if (shouldEmit) {
        context.emit("route:cache:failed", {
          routeId,
          exchangeId: exchange.id,
          correlationId,
          stepLabel,
          scope: "step",
          phase,
          key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // Inner-step failures propagate unchanged so route-level handlers
      // see the real cause (matching unwrapped step behaviour). Provider
      // read / write failures map to the retryable RC5028 boundary code
      // unless the provider already threw a RoutecraftError.
      if (phase !== "inner" && !isRoutecraftError(err)) {
        throw rcError("RC5028", err, {
          message: `cache() provider ${phase === "get" ? "read" : "write"} failed for "${stepLabel}"`,
        });
      }
      throw err;
    }

    if (shouldEmit) {
      context.emit(ranInner ? "route:cache:miss" : "route:cache:hit", {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        stepLabel,
        scope: "step",
        key,
      });
      if (ranInner) {
        context.emit("route:cache:stored", {
          routeId,
          exchangeId: exchange.id,
          correlationId,
          stepLabel,
          scope: "step",
          key,
          ...(this.#options.ttl !== undefined
            ? { ttl: this.#options.ttl }
            : {}),
        });
      }
    }

    // On a miss (this call ran the inner), forward the inner's produced
    // exchange so its header mutations and body survive. On a hit or
    // stampede-dedup the inner did not run for THIS exchange, so rewrap
    // the current exchange with the cached body: a cache hit means the
    // wrapped step's side effects (including header writes) did not
    // happen for this exchange.
    const forwarded =
      ranInner && producedExchange !== undefined
        ? producedExchange
        : DefaultExchange.rewrap(exchange, { body: computed });
    return { kind: "continue", exchange: forwarded };
  }
}
