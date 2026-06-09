import { createHash } from "node:crypto";

import {
  type Exchange,
  DefaultExchange,
  getExchangeContext,
  getExchangeRoute,
  HeadersKeys,
  isDropped,
  markDropped,
} from "../exchange.ts";
import { rcError, RoutecraftError } from "../error.ts";
import { isRoutecraftError } from "../brand.ts";
import type { Adapter, EventName, Step } from "../types.ts";
import { WrapperStep, type WrapperOutcome } from "./wrapper.ts";
import {
  type CacheProvider,
  defaultMemoryCacheProvider,
} from "./cache-provider.ts";

/**
 * Options for the `.cache()` step-scope wrapper.
 *
 * @template Current Body type entering the wrapped step.
 * @experimental
 */
export interface CacheOptions<Current = unknown> {
  /**
   * Derive the cache key from the exchange. The returned string is the
   * identity used by the provider's `get` / `set`. When omitted, a key
   * is computed by SHA-256 hashing `JSON.stringify(body)`.
   *
   * The default works for plain JSON-shaped bodies (primitives, arrays,
   * plain objects with string keys). For bodies containing functions,
   * symbols, circular references, or anything else `JSON.stringify`
   * cannot represent, supply an explicit `key` function.
   *
   * Performance: the default hashes a JSON serialisation of the body on
   * every exchange. For hot paths or large bodies (file contents, large
   * payloads), supply a `key` that returns a stable identifier already
   * to hand (an id field, a content hash in a header, a tuple of the
   * relevant fields) to avoid re-serialising and re-hashing.
   */
  key?: (exchange: Exchange<Current>) => string;
  /**
   * Time to live in milliseconds. After expiry, the next execution
   * with the same key recomputes the value. When omitted, the
   * provider's default applies (the bundled in-memory provider keeps
   * entries until LRU eviction).
   */
  ttl?: number;
  /**
   * Cache backend. Defaults to a process-wide in-memory provider. Pass
   * a custom provider (Redis, multi-tier, file-backed, etc.) by
   * constructing an implementation of {@link CacheProvider} and
   * handing it in here.
   */
  provider?: CacheProvider;
}

/**
 * Internal resolved shape of {@link CacheOptions}: every field is
 * populated, with defaults filled in. Shared between the step-scope
 * wrapper and the route-scope path in `route.ts`.
 *
 * @internal
 */
export interface ResolvedCacheOptions<Current = unknown> {
  key: (exchange: Exchange<Current>) => string;
  ttl: number | undefined;
  provider: CacheProvider;
}

/**
 * Resolve a user-supplied {@link CacheOptions} into a fully populated
 * {@link ResolvedCacheOptions}, filling defaults: the SHA-256 body
 * hasher for `key`, no TTL, and the module-level in-memory provider.
 *
 * @internal
 */
export function resolveCacheOptions<Current = unknown>(
  options: CacheOptions<Current> = {},
): ResolvedCacheOptions<Current> {
  return {
    key: options.key ?? (defaultKey as (e: Exchange<Current>) => string),
    ttl: options.ttl,
    provider: options.provider ?? defaultMemoryCacheProvider,
  };
}

function defaultKey(exchange: Exchange<unknown>): string {
  try {
    const stringified = JSON.stringify(exchange.body);
    if (stringified === undefined) {
      throw rcError("RC5029", undefined, {
        message:
          "Default cache key derivation failed: exchange body is not JSON-serialisable. " +
          "Supply an explicit `key` function in cache({ key: ... }).",
      });
    }
    return createHash("sha256").update(stringified).digest("hex");
  } catch (err) {
    if (err instanceof RoutecraftError) throw err;
    throw rcError("RC5029", err, {
      message:
        "Default cache key derivation threw while hashing the exchange body. " +
        "Supply an explicit `key` function in cache({ key: ... }).",
    });
  }
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
 *
 * Concurrent exchanges with the same derived key share a single
 * computation via the provider's `getOrCompute`, so a slow underlying
 * operation runs at most once per key per TTL window.
 *
 * Emits cache lifecycle events on the route's event bus:
 * - `route:<id>:cache:hit` when a cached value is reused.
 * - `route:<id>:cache:miss` when the wrapped step runs.
 * - `route:<id>:cache:stored` when a fresh value is written.
 * - `route:<id>:cache:failed` when key derivation or the provider throws.
 *
 * Known limitation: concurrent exchanges that share a single
 * `getOrCompute` computation (stampede dedupe) currently report
 * `cache:hit` for the waiters rather than a distinct "deduped" signal,
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
 * @experimental Surfaced via the dual-mode `.cache()` builder method;
 * route-scope behaviour is tracked in #112 and currently throws when
 * staged before `.from()`.
 */
export class CacheWrapperStep<
  T extends Adapter = Adapter,
> extends WrapperStep<T> {
  readonly #options: ResolvedCacheOptions;

  constructor(inner: Step<T>, options: CacheOptions = {}) {
    super(inner);
    this.#options = resolveCacheOptions(options);
  }

  protected override async runInner(
    exchange: Exchange,
    innerQueue: { exchange: Exchange; steps: Step<Adapter>[] }[],
  ): Promise<WrapperOutcome> {
    const route = getExchangeRoute(exchange);
    const context = getExchangeContext(exchange);
    const routeId = route?.definition.id;
    const stepLabel = this.label ?? String(this.operation);
    const correlationId = exchange.headers[
      HeadersKeys.CORRELATION_ID
    ] as string;
    const shouldEmit = route && context && routeId;

    let key: string;
    try {
      key = this.#options.key(exchange);
    } catch (err) {
      if (shouldEmit) {
        context.emit(`route:${routeId}:cache:failed` as EventName, {
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
          // Run the inner step against an isolated local buffer so the
          // shared `innerQueue` is populated uniformly from the cache
          // result below. Concurrent callers waiting on this loader
          // never see the inner's intermediate pushes.
          const localQueue: {
            exchange: Exchange;
            steps: Step<Adapter>[];
          }[] = [];
          await this.inner.execute(exchange, [], localQueue);
          // A genuine drop is signalled by the framework's dropped flag
          // (filter reject / halt), NOT by an undefined body: a step
          // such as `transform(() => undefined)` legitimately sets the
          // body to undefined and must not be misread as a drop.
          if (isDropped(exchange) || localQueue.length === 0) {
            // Abort via sentinel so `getOrCompute` writes nothing.
            throw new CacheLoaderDrop();
          }
          if (localQueue.length > 1) {
            // The wrapper caches and replays a single output. A
            // multi-emit inner step would have all but one output
            // silently dropped, so fail loud instead. split / aggregate
            // are already blocked at construction by WrapperStep.
            throw rcError("RC5003", undefined, {
              message:
                `.cache() cannot wrap "${stepLabel}": the step emitted ${localQueue.length} ` +
                `exchanges, but cache replays a single output. Wrap a single-output step instead.`,
            });
          }
          const produced = localQueue[0]!;
          producedExchange = produced.exchange;
          loaderResolved = true;
          return produced.exchange.body;
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
          context.emit(`route:${routeId}:cache:miss` as EventName, {
            routeId,
            exchangeId: exchange.id,
            correlationId,
            stepLabel,
            scope: "step",
            key,
            dropped: true,
          });
        }
        return "ok";
      }
      // Attribute the failure:
      // - `"get"`   provider read threw before the inner ran.
      // - `"inner"` the wrapped step itself threw (loader not resolved).
      // - `"set"`   the inner succeeded but the provider write threw.
      const phase = !ranInner ? "get" : loaderResolved ? "set" : "inner";
      if (shouldEmit) {
        context.emit(`route:${routeId}:cache:failed` as EventName, {
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
      context.emit(
        `route:${routeId}:cache:${ranInner ? "miss" : "hit"}` as EventName,
        {
          routeId,
          exchangeId: exchange.id,
          correlationId,
          stepLabel,
          scope: "step",
          key,
        },
      );
      if (ranInner) {
        context.emit(`route:${routeId}:cache:stored` as EventName, {
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
    innerQueue.push({ exchange: forwarded, steps: [] });
    return "ok";
  }
}
