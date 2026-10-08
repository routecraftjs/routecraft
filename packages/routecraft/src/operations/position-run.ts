import type { Exchange } from "../exchange.ts";
import { rcError } from "../error.ts";
import type { Port } from "../kernel/port.ts";
import {
  RESILIENCE,
  type Position,
  type PositionRun,
  type PositionScope,
  type ResiliencePositions,
} from "../kernel/positions.ts";
import type { ForwardFn, Route } from "../route.ts";
import { anySignal } from "../shared/abort.ts";
import type { Adapter, Step, StepContext, StepOutcome } from "../types.ts";
import { wrapperEventScope, type WrappingStep } from "./event-scope.ts";

export type { WrappingStep } from "./event-scope.ts";

/** The scope a step-scope wrapper runs in. */
export function stepScopeOf(
  step: WrappingStep,
  exchange: Exchange,
): PositionScope {
  const { routeId, stepLabel } = wrapperEventScope(exchange, step);
  return { routeId, scope: "step", stepLabel };
}

/**
 * The position a wrapper runs, from the provider of `port` in the
 * application the exchange belongs to, built once per application: its
 * state (a breaker's window, a bulkhead's slots) belongs to this wrapper in
 * that application, and a definition shared across applications keeps one
 * per application. A wrapper placed after `.from()` is the same position as
 * its route-scope twin, so one plugin replacing the port fills both.
 *
 * `perRoute` builds one per route in the application instead, for a
 * position whose build bakes the route's scope in (the throttle gate): a
 * wrapped step shared by two routes would otherwise report the first
 * route's id on the second route's events.
 *
 * The provider is resolved when an exchange first reaches the wrapper, so a
 * missing one fails that exchange; the route-scope twin is compiled before
 * the route starts and refuses at startup instead.
 *
 * @throws RC1111 when the exchange carries no application, or no installed
 *   plugin provides the port
 */
export function positionFor<P, T>(
  built: WeakMap<object, T>,
  exchange: Exchange,
  step: WrappingStep,
  port: Port<P>,
  method: string,
  build: (provider: P) => T,
  options: { perRoute?: boolean } = {},
): T {
  const { context, route, stepLabel } = wrapperEventScope(exchange, step);
  if (context === undefined) {
    throw rcError("RC1111", undefined, {
      message: `Step "${stepLabel}" is wrapped in .${method}(), which runs the "${port.name}" position of the application the exchange belongs to, and this exchange belongs to none. Run the step through a route in a started context.`,
    });
  }
  const provider = context.lookup(port);
  if (provider === undefined) {
    throw rcError("RC1111", undefined, {
      message: `Step "${stepLabel}" is wrapped in .${method}(), and no installed plugin provides "${port.name}". Install a plugin that provides it, or remove .${method}() from the route.`,
    });
  }
  const key = options.perRoute ? (route ?? context) : context;
  let position = built.get(key);
  if (position === undefined) {
    position = build(provider);
    built.set(key, position);
  }
  return position;
}

/**
 * One run of a step-scope resilience wrapper: the position `method` names,
 * from the application's `RESILIENCE` provider, over the wrapped step.
 */
export function runStepPosition(
  step: WrappingStep,
  inner: Step<Adapter>,
  built: WeakMap<object, Position>,
  method: keyof ResiliencePositions,
  build: (provider: ResiliencePositions) => Position,
  exchange: Exchange,
  ctx: StepContext,
): Promise<StepOutcome> {
  return positionFor(built, exchange, step, RESILIENCE, method, build).run(
    stepPositionRun(step, inner, exchange, ctx),
  );
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
  const { route, context, routeId, stepLabel } = wrapperEventScope(
    exchange,
    step,
  );
  const abandon = ctx.signal;
  return {
    routeId,
    scope: "step",
    stepLabel,
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
