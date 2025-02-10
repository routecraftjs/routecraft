import { CraftContext } from "./context.ts";
import { type Logger, createLogger } from "./logger.ts";

export enum OperationType {
  /** The exchange was created from a source */
  FROM = "from",
  /** The exchange was processed by a processor */
  PROCESS = "process",
  /** The exchange was sent to a destination */
  TO = "to",
  /** The exchange was split into multiple exchanges */
  SPLIT = "split",
  /** The exchange was aggregated from multiple exchanges */
  AGGREGATE = "aggregate",
  /** Modify the body of the exchange */
  TRANSFORM = "transform",
  /** Tap an exchange without modifying it */
  TAP = "tap",
  /** Filter an exchange based on a condition and reject the message if the condition is not met */
  FILTER = "filter",
  /** Validate the exchange against a schema and reject the message if the schema is not met */
  VALIDATE = "validate",
}

export enum HeadersKeys {
  /** The operation type (from, process, to) */
  OPERATION = "routecraft.operation",
  /** The route id */
  ROUTE_ID = "routecraft.route",
  /** The correlation id */
  CORRELATION_ID = "routecraft.correlation_id",
  /** The hierarchy of split groups this exchange belongs to */
  SPLIT_HIERARCHY = "routecraft.split_hierarchy",
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

export interface RouteCraftHeaders {
  [HeadersKeys.OPERATION]: OperationType;
  [HeadersKeys.ROUTE_ID]: string;
  [HeadersKeys.CORRELATION_ID]: string;
  [HeadersKeys.SPLIT_HIERARCHY]?: string[];
  [HeadersKeys.TIMER_TIME]?: string;
  [HeadersKeys.TIMER_FIRED_TIME]?: string;
  [HeadersKeys.TIMER_PERIOD_MS]?: number;
  [HeadersKeys.TIMER_COUNTER]?: number;
  [HeadersKeys.TIMER_NEXT_RUN]?: string;
}

export type HeaderValue = string | number | boolean | undefined | string[];

export type ExchangeHeaders = Partial<RouteCraftHeaders> &
  Record<string, HeaderValue>;

export type Exchange<T = unknown> = {
  readonly id: string;
  readonly headers: ExchangeHeaders;
  body: T;
  logger: Logger;
};

export class DefaultExchange<T = unknown> implements Exchange<T> {
  readonly id: string;
  readonly headers: ExchangeHeaders;
  body: T;
  public readonly logger: Logger;

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
    this.logger = createLogger(this);
  }
}
