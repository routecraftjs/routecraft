import { CraftContext } from "./context.ts";
import { type Logger, createLogger } from "./logger.ts";

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
}

export interface RouteCraftHeaders {
  [HeadersKeys.OPERATION]: OperationType;
  [HeadersKeys.ROUTE_ID]: string;
  [HeadersKeys.CORRELATION_ID]: string;
  [HeadersKeys.ADAPTER]: string;
}

export type HeaderValue = string | number | boolean | undefined;

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
