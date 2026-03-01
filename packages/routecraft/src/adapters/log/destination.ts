import { type Destination } from "../../operations/to";
import { type Exchange } from "../../exchange";
import type { LogLevel, LogOptions } from "./types";

const DEFAULT_LEVEL: LogLevel = "info";

export class LogDestinationAdapter<T = unknown> implements Destination<
  T,
  void
> {
  readonly adapterId = "routecraft.adapter.log";

  private readonly level: LogLevel;
  private readonly formatter: ((exchange: Exchange<T>) => unknown) | undefined;

  constructor(
    formatter?: (exchange: Exchange<T>) => unknown,
    options?: LogOptions,
  ) {
    this.formatter = formatter;
    this.level = options?.level ?? DEFAULT_LEVEL;
  }

  send(exchange: Exchange<T>): Promise<void> {
    const logData = this.formatter
      ? this.formatter(exchange)
      : this.baseExchange(exchange);
    const adapterLabel = this.adapterId.split(".").pop();
    const bindings =
      typeof logData === "object" && logData !== null
        ? { ...logData, adapter: adapterLabel }
        : { adapter: adapterLabel, value: logData };
    exchange.logger[this.level](bindings, "LogAdapter output");
    return Promise.resolve();
  }

  private baseExchange(exchange: Exchange<T>): Partial<Exchange<T>> {
    const { id, body, headers } = exchange;
    return { id, body, headers };
  }
}
