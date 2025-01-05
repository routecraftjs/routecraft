export enum OperationType {
  FROM = "from",
  PROCESS = "process",
  TO = "to",
}

export enum HeadersKeys {
  OPERATION = "routecraft.core.operation",
  ROUTE_ID = "routecraft.core.route",
}

export type RouteCraftHeaders = {
  [HeadersKeys.OPERATION]: OperationType;
  [HeadersKeys.ROUTE_ID]: string;
};

export type HeaderValue = string | number | boolean | undefined;

export type ExchangeHeaders =
  & Partial<RouteCraftHeaders>
  & Record<string, HeaderValue>;

export type Exchange<T = unknown> = {
  readonly id: string;
  headers: ExchangeHeaders;
  body: T;
};
