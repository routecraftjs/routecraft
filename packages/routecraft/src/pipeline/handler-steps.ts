/**
 * The handler points the pipeline hosts as steps.
 *
 * `admission` and `entry` are positions in the pre-from filter chain, so
 * they are steps like the parse and input positions beside them: that is
 * what gives them the chain's own failure path, its step events and its
 * ordering guarantees rather than a second mechanism running alongside it.
 * `exit` is not here, because it runs after the last step rather than as
 * one.
 */

import {
  type Exchange,
  DefaultExchange,
  HeadersKeys,
  OperationType,
  emitExchangeDropped,
} from "../exchange.ts";
import { anySignal } from "../shared/abort.ts";
import { consultHandlers } from "../handlers/consult.ts";
import {
  decoratedHeaders,
  isHeaderDecoration,
  mergeHeaderDecoration,
  type EntryHandler,
  type HandlerExecution,
  type HeaderDecoration,
} from "../handlers/types.ts";
import { DeferralHeaders } from "../deferral/exchange-state.ts";
import { isRecovery } from "../recovery.ts";
import { rcError } from "../error.ts";
import type { Adapter, Step } from "../types.ts";
import { processError, type ExecutorDeps } from "./executor.ts";

/** Synthetic carrier for the entry point. The step's `execute` does the work. */
const ENTRY_STEP_ADAPTER: Adapter = { adapterId: "routecraft.handler.entry" };

/**
 * Which run of the exchange a handler is being consulted on.
 *
 * The revival stamps `resumedAt`, so the header is the fact rather than a
 * counter the framework would have to keep in step with it.
 *
 * @internal
 */
export function executionOf(exchange: Exchange): HandlerExecution {
  return exchange.headers[DeferralHeaders.RESUMED_AT] !== undefined ? 2 : 1;
}

/**
 * What a handler that answered with neither a decoration nor a refusal gets.
 *
 * Named rather than ignored: a handler returning its own object would
 * otherwise look like it had decorated and change nothing.
 *
 * @internal
 */
export function unreadableAnswer(point: string, expected: string): Error {
  return rcError("RC5003", undefined, {
    message: `A "${point}" handler returned something that is neither ${expected} nor recovery.drop(reason). Return undefined to pass.`,
  });
}

/**
 * Build the `entry` position of the pre-from chain (#4.5).
 *
 * After `input` and before `throttle`, which is the one window where the
 * caller is known and the body is validated but nothing has been spent: the
 * chain's own rule is that a position which can refuse must not sit below
 * something that consumes a resource, so a refusal here costs no throttle
 * token and consults no cache.
 *
 * Inserted only where the point has handlers, so a route in a context with
 * none carries no extra step.
 *
 * @internal
 */
export function buildEntryHandlerStep(deps: ExecutorDeps): Step<Adapter> {
  return {
    operation: OperationType.PROCESS,
    label: "entry",
    adapter: ENTRY_STEP_ADAPTER,
    async execute(exchange) {
      const handlers = deps.context.getHandlers("entry", deps.route);
      if (handlers.length === 0) return { kind: "continue", exchange };
      const correlationId = exchange.headers[
        HeadersKeys.CORRELATION_ID
      ] as string;
      const signal = anySignal(deps.route.signal, deps.abortSignal);
      const execution = executionOf(exchange);
      // An object rather than the reason string: `recovery.drop()` carries no
      // reason, and a bare `undefined` settlement would be indistinguishable
      // from no settlement at all.
      const { settlement, carried } = await consultHandlers<
        EntryHandler,
        { readonly reason?: string },
        HeaderDecoration
      >(handlers, {
        announce: () => {
          deps.context.emit("route:handler:invoked", {
            routeId: deps.routeId,
            exchangeId: exchange.id,
            correlationId,
            point: "entry",
          });
        },
        // Each handler sees what the ones before it decorated, which is what
        // makes two plugins stamping their own header both take effect.
        invoke: (handler, decorated) =>
          handler({
            exchange: decorated
              ? DefaultExchange.rewrap(exchange, {
                  headers: decoratedHeaders(decorated),
                })
              : exchange,
            route: deps.route,
            execution,
            signal,
          }),
        read: (answer) => {
          if (answer === undefined) return { kind: "pass" };
          if (isRecovery(answer) && answer.kind === "drop")
            return {
              kind: "settle",
              settlement:
                answer.reason === undefined ? {} : { reason: answer.reason },
            };
          if (isHeaderDecoration(answer))
            return { kind: "decorate", decoration: answer };
          throw unreadableAnswer("entry", "a header decoration ({ headers })");
        },
        merge: mergeHeaderDecoration,
        report: (thrown, index, aborted) => {
          const err = processError(thrown);
          exchange.logger.error(
            {
              operation: "entry",
              err,
              context: aborted
                ? "entry handler, cut short by the route stopping"
                : "entry handler",
              handlerIndex: index,
            },
            err.meta.message,
          );
          deps.context.emit("route:handler:failed", {
            routeId: deps.routeId,
            exchangeId: exchange.id,
            correlationId,
            point: "entry",
            handlerIndex: index,
            error: err,
          });
        },
        signal,
      });
      // A refusal is a decision rather than an error, so it takes the shape
      // a `.filter()` rejection does: `exchange:dropped` with the handler's
      // reason and no failure events. Reporting it as a failure would put a
      // plugin's ordinary policy into the route's failure metrics.
      if (settlement !== undefined) {
        emitExchangeDropped(deps.context, {
          routeId: deps.routeId,
          correlationId,
          reason: settlement.reason ?? "refused by an entry handler",
          exchange,
        });
        return { kind: "drop" };
      }
      return {
        kind: "continue",
        exchange: carried
          ? DefaultExchange.rewrap(exchange, {
              headers: decoratedHeaders(carried),
            })
          : exchange,
      };
    },
  };
}
