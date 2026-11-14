import { DIGEST_EXEMPT } from "../dsl-symbol.ts";
import { type Exchange, OperationType } from "../exchange.ts";
import { readonlyExchange } from "../kernel/readonly.ts";
import type { LogBindings, StepLogLevel } from "../logger.ts";
import type { Adapter, Step, StepOutcome } from "../types.ts";

/** The level of a `.log()` line: fixed, or chosen from the exchange. */
export type LogStepLevel<T = unknown> =
  StepLogLevel | ((exchange: Readonly<Exchange<T>>) => StepLogLevel);

/** The fields a `.log()` line carries beside its message. */
export type LogStepBindings<T = unknown> = (
  exchange: Readonly<Exchange<T>>,
) => LogBindings;

const LEVELS: readonly string[] = ["trace", "debug", "info", "warn"];

/**
 * The step behind `.log(level, message, bindings?)`: one line on the
 * exchange's own logger, written in the flow, so it carries the exchange's
 * id and lands in step order.
 *
 * It reports and never changes. `level` and `bindings` see the exchange
 * through a read-only view, and anything either of them throws costs the
 * line and not the exchange: it becomes one `warn`, "Log line could not be
 * built", and the route carries on.
 *
 * The digest a continuation is checked against leaves this step out, so a
 * log line can be added or reworded while exchanges are parked.
 *
 * @internal
 */
export class LogStep<T = unknown> implements Step<Adapter> {
  readonly operation: OperationType = OperationType.OBSERVE;
  readonly adapter: Adapter = { adapterId: "routecraft.adapter.log" };
  label?: string;
  readonly [DIGEST_EXEMPT] = true as const;
  readonly #level: LogStepLevel<T>;
  readonly #message: string;
  readonly #bindings: LogStepBindings<T> | undefined;

  constructor(
    level: LogStepLevel<T>,
    message: string,
    bindings?: LogStepBindings<T>,
  ) {
    this.#level = level;
    this.#message = message;
    this.#bindings = bindings;
  }

  execute(exchange: Exchange<T>): Promise<StepOutcome> {
    const logger = exchange.logger;
    try {
      const fixed = typeof this.#level === "string" ? this.#level : undefined;
      if (fixed === undefined || logger.isLevelEnabled(fixed)) {
        const view = readonlyExchange(exchange, ".log()");
        const level =
          fixed ?? (this.#level as Exclude<LogStepLevel<T>, string>)(view);
        if (!LEVELS.includes(level)) {
          throw new TypeError(
            `.log() writes at trace, debug, info or warn; the level function returned ${JSON.stringify(level)}.`,
          );
        }
        if (logger.isLevelEnabled(level)) {
          const bindings = this.#bindings?.(view);
          if (bindings === undefined) logger[level](this.#message);
          else logger[level](bindings, this.#message);
        }
      }
    } catch (err) {
      logger.warn({ err, line: this.#message }, "Log line could not be built");
    }
    return Promise.resolve({ kind: "continue", exchange });
  }
}
