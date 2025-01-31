import { CraftContext } from "./context.ts";

export enum OperationType {
  FROM = "from",
  PROCESS = "process",
  TO = "to",
}

export enum HeadersKeys {
  OPERATION = "routecraft.operation",
  ROUTE_ID = "routecraft.route",
  CORRELATION_ID = "routecraft.correlation_id",
}

export type RouteCraftHeaders = {
  [HeadersKeys.OPERATION]: OperationType;
  [HeadersKeys.ROUTE_ID]: string;
  [HeadersKeys.CORRELATION_ID]: string;
};

export type HeaderValue = string | number | boolean | undefined;

export type ExchangeHeaders = Partial<RouteCraftHeaders> &
  Record<string, HeaderValue>;

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
