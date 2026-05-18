import { createHash } from "node:crypto";

import {
  type Exchange,
  DefaultExchange,
  getExchangeContext,
  getExchangeRoute,
  HeadersKeys,
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

interface ResolvedCacheOptions<Current = unknown> {
  key: (exchange: Exchange<Current>) => string;
  ttl: number | undefined;
  provider: CacheProvider;
}

function defaultKey(exchange: Exchange<unknown>): string {
  try {
    const stringified = JSON.stringify(exchange.body);
    if (stringified === undefined) {
      throw rcError("RC5018", undefined, {
        message:
          "Default cache key derivation failed: exchange body is not JSON-serialisable. " +
          "Supply an explicit `key` function in cache({ key: ... }).",
      });
    }
    return createHash("sha256").update(stringified).digest("hex");
  } catch (err) {
    if (err instanceof RoutecraftError) throw err;
    throw rcError("RC5018", err, {
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
 * - `route:<id>:cache:failed` when the provider itself throws.
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
    this.#options = {
      key: options.key ?? defaultKey,
      ttl: options.ttl,
      provider: options.provider ?? defaultMemoryCacheProvider,
    };
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
          failedOperation: stepLabel,
          stepLabel,
          scope: "step",
          phase: "key",
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw isRoutecraftError(err)
        ? err
        : rcError("RC5018", err, {
            message: `cache({ key }) for "${stepLabel}" threw while deriving the cache key`,
          });
    }

    let ranInner = false;
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
          const produced = localQueue[localQueue.length - 1];
          if (!produced || produced.exchange.body === undefined) {
            // Inner dropped the exchange (filter / halt) or produced
            // no body. Abort via a sentinel throw so `getOrCompute`
            // does NOT write anything to the cache. Caught below and
            // translated to a drop forward.
            throw new CacheLoaderDrop();
          }
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
            failedOperation: stepLabel,
            stepLabel,
            scope: "step",
            key,
            dropped: true,
          });
        }
        return "ok";
      }
      if (shouldEmit) {
        context.emit(`route:${routeId}:cache:failed` as EventName, {
          routeId,
          exchangeId: exchange.id,
          correlationId,
          failedOperation: stepLabel,
          stepLabel,
          scope: "step",
          phase: ranInner ? "inner" : "get",
          error: err instanceof Error ? err.message : String(err),
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
          failedOperation: stepLabel,
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
          failedOperation: stepLabel,
          stepLabel,
          scope: "step",
          key,
          ...(this.#options.ttl !== undefined
            ? { ttl: this.#options.ttl }
            : {}),
        });
      }
    }

    // Push the (cached or freshly computed) body forward. Both paths
    // resolve to the same shape so the template method relays a
    // single exchange with the new body to the rest of the pipeline.
    innerQueue.push({
      exchange: DefaultExchange.rewrap(exchange, { body: computed }),
      steps: [],
    });
    return "ok";
  }
}
