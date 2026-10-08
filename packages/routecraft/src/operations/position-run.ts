import {
  type Exchange,
  getExchangeContext,
  getExchangeRoute,
  HeadersKeys,
  type OperationType,
} from "../exchange.ts";
import { rcError } from "../error.ts";
import type { Port } from "../kernel/port.ts";
import {
  CACHE,
  RESILIENCE,
  type CachePositions,
  type PositionRun,
  type PositionScope,
  type ResiliencePositions,
} from "../kernel/positions.ts";
import type { ForwardFn, Route } from "../route.ts";
import { anySignal } from "../shared/abort.ts";
import type { Adapter, Step, StepContext } from "../types.ts";

/** What a step-scope wrapper is, for the run it builds. */
export interface WrappingStep {
  readonly label?: string;
  readonly operation: OperationType;
}

/** The scope a step-scope wrapper runs in. */
export function stepScopeOf(
  step: WrappingStep,
  exchange: Exchange,
): PositionScope {
  const route = getExchangeRoute(exchange);
  return {
    routeId:
      route?.definition.id ??
      (exchange.headers[HeadersKeys.ROUTE_ID] as string),
    scope: "step",
    stepLabel: step.label ?? String(step.operation),
  };
}

/**
 * The provider a step-scope wrapper runs through, from the application the
 * exchange belongs to. A wrapper placed after `.from()` is the same position
 * as its route-scope twin, so one plugin replacing the port fills both.
 *
 * @throws RC1111 when no installed plugin provides the port, as a route
 *   configuring the position at route scope refuses to start
 */
function providerOf<T>(
  exchange: Exchange,
  port: Port<T>,
  step: WrappingStep,
  method: string,
): { context: object; provider: T } {
  const context = getExchangeContext(exchange);
  const provider = context?.lookup(port);
  if (context === undefined || provider === undefined) {
    throw rcError("RC1111", undefined, {
      message: `Step "${step.label ?? String(step.operation)}" is wrapped in .${method}(), and no installed plugin provides "${port.name}". Install a plugin that provides it, or remove .${method}() from the route.`,
    });
  }
  return { context, provider };
}

/**
 * The position a wrapper runs, built once per application: its state (a
 * breaker's window, a bulkhead's slots) belongs to this wrapper in that
 * application, and a definition shared across applications keeps one per
 * application.
 */
export function stepPosition<T>(
  built: WeakMap<object, T>,
  exchange: Exchange,
  step: WrappingStep,
  method: string,
  build: (provider: ResiliencePositions) => T,
): T {
  const { context, provider } = providerOf(exchange, RESILIENCE, step, method);
  let position = built.get(context);
  if (position === undefined) {
    position = build(provider);
    built.set(context, position);
  }
  return position;
}

/** As {@link stepPosition}, for the `CACHE` port. */
export function stepCache<T>(
  built: WeakMap<object, T>,
  exchange: Exchange,
  step: WrappingStep,
  build: (provider: CachePositions) => T,
): T {
  const { context, provider } = providerOf(exchange, CACHE, step, "cache");
  let position = built.get(context);
  if (position === undefined) {
    position = build(provider);
    built.set(context, position);
  }
  return position;
}

function forwardOf(route: Route | undefined, caller: Exchange): ForwardFn {
  if (route) return route.getForward(caller);
  return () =>
    Promise.reject(
      rcError("RC5001", undefined, {
        message:
          "forward() requires a route, and this step ran without a route binding.",
      }),
    );
}

/**
 * One run of a step-scope position: the wrapped step is the attempt, an
 * enclosing deadline is the abandon signal, and the route's intake signal
 * cuts a wait short once shutdown begins.
 */
export function stepPositionRun(
  step: WrappingStep,
  inner: Step<Adapter>,
  exchange: Exchange,
  ctx: StepContext,
): PositionRun {
  const route = getExchangeRoute(exchange);
  const context = getExchangeContext(exchange);
  const abandon = ctx.signal;
  return {
    ...stepScopeOf(step, exchange),
    route: route ?? step,
    exchange,
    signal: anySignal(route?.intakeSignal, abandon),
    ...(abandon ? { abandon } : {}),
    mustWait: false,
    forward: forwardOf(route, exchange),
    emit: (event, details) => context?.emit(event, details),
    attempt: (signal) =>
      inner.execute(
        exchange,
        signal ? { ...ctx, signal: anySignal(ctx.signal, signal) } : ctx,
      ),
  };
}
