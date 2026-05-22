import type { Exchange } from "../../exchange";

/**
 * Reserved config for HTTP (future: inbound server port, host).
 * No-op today; used by built-in HTTP server when implemented.
 */
export type HttpConfig = Record<string, unknown>;

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

export type QueryParams = Record<string, string | number | boolean>;

export interface HttpOptions<T = unknown> {
  method?: HttpMethod;
  url: string | ((exchange: Exchange<T>) => string);
  headers?:
    | Record<string, string>
    | ((exchange: Exchange<T>) => Record<string, string>);
  query?: QueryParams | ((exchange: Exchange<T>) => QueryParams);
  body?: unknown | ((exchange: Exchange<T>) => unknown);
  timeoutMs?: number;
  throwOnHttpError?: boolean;
}

export type HttpResult<T = string | unknown> = {
  status: number;
  headers: Record<string, string>;
  body: T;
  url: string;
};
