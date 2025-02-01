import { CraftContext } from "./context.ts";

export enum OperationType {
  /** The exchange was created from a source */
  FROM = "from",
  /** The exchange was processed by a processor */
  PROCESS = "process",
  /** The exchange was sent to a destination */
  TO = "to",
}

export enum HeadersKeys {
  /** The operation type (from, process, to) */
  OPERATION = "routecraft.operation",
  /** The route id */
  ROUTE_ID = "routecraft.route",
  /** The correlation id */
  CORRELATION_ID = "routecraft.correlation_id",
  /** The adapter name */
  ADAPTER = "routecraft.adapter",
  /** The exact timestamp when the timer fired. ISO 8601 format   */
  TIMER_TIME = "routecraft.timer.time",
  /**The timestamp when the exchange was created. ISO 8601 format */
  TIMER_FIRED_TIME = "routecraft.timer.firedTime",
  /** The period in milliseconds between timer firings */
  TIMER_PERIOD_MS = "routecraft.timer.periodMs",
  /** The number of times the timer has fired */
  TIMER_COUNTER = "routecraft.timer.counter",
  /** The next timestamp when the timer will fire. ISO 8601 format */
  TIMER_NEXT_RUN = "routecraft.timer.nextRun",
}

export type RouteCraftHeaders = {
  [HeadersKeys.OPERATION]: OperationType;
  [HeadersKeys.ROUTE_ID]: string;
  [HeadersKeys.CORRELATION_ID]: string;
  [HeadersKeys.ADAPTER]: string;
  [HeadersKeys.TIMER_TIME]?: string;
  [HeadersKeys.TIMER_FIRED_TIME]?: string;
  [HeadersKeys.TIMER_PERIOD_MS]?: number;
  [HeadersKeys.TIMER_COUNTER]?: number;
  [HeadersKeys.TIMER_NEXT_RUN]?: string;
};

export type HeaderValue = string | number | boolean | undefined;

export type ExchangeHeaders = Partial<RouteCraftHeaders>;

export type Exchange<T = unknown> = {
  readonly id: string;
  readonly headers: ExchangeHeaders;
  body: T;
};

export class DefaultExchange<T = unknown> implements Exchange<T> {
  readonly id: string;
  readonly headers: ExchangeHeaders;
  body: T;

  constructor(
    public readonly context: CraftContext,
    options?: Partial<Exchange<T>>,
  ) {
    this.id = options?.id || crypto.randomUUID();
    this.headers = {
      [HeadersKeys.ROUTE_ID]: crypto.randomUUID(),
      [HeadersKeys.OPERATION]: OperationType.FROM,
      [HeadersKeys.CORRELATION_ID]: crypto.randomUUID(),
      ...(options?.headers || {}),
    };
    this.body = options?.body || ({} as T);
  }
}
