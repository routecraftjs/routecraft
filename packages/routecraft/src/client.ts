import type { CraftContext } from "./context.ts";
import type { Exchange, ExchangeHeaders } from "./exchange.ts";
import { DefaultExchange } from "./exchange.ts";
import { rcError } from "./error.ts";
import {
  ADAPTER_DIRECT_STORE,
  sanitizeEndpoint,
} from "./adapters/direct/shared.ts";

/**
 * Programmatic client for dispatching messages into running routes.
 *
 * Use this to call routes from external code (CLI frameworks, HTTP servers,
 * application logic) without coupling to the CraftContext internals.
 *
 * Returned alongside the context from `ContextBuilder.build()`.
 *
 * @experimental
 *
 * @example
 * ```typescript
 * const { context, client } = await new ContextBuilder()
 *   .routes(capabilities)
 *   .build();
 *
 * await context.start();
 *
 * // Dispatch from Commander action
 * program.command('greet').action(async (name) => {
 *   const result = await client.send('greet', { name });
 *   console.log(result);
 * });
 * ```
 */
export class CraftClient {
  constructor(private readonly ctx: CraftContext) {}

  /**
   * Send a message to a direct endpoint and return the result.
   *
   * The context must be started and the target route must be subscribed
   * before calling send.
   *
   * @param endpoint - Direct endpoint name (must match the endpoint string passed to `direct(endpoint, options)`)
   * @param body - Request body
   * @param headers - Optional exchange headers
   * @returns The response body from the route
   * @throws {RoutecraftError} RC5004 if no direct channel exists for the endpoint
   */
  async send<T = unknown, R = T>(
    endpoint: string,
    body: T,
    headers?: ExchangeHeaders,
  ): Promise<R> {
    const store = this.ctx.getStore(ADAPTER_DIRECT_STORE);
    const sanitized = sanitizeEndpoint(endpoint);
    const channel = store?.get(sanitized);
    if (!channel) {
      throw rcError("RC5004", undefined, {
        message: `No direct channel for endpoint "${endpoint}". Is the context started and does a route subscribe to this endpoint?`,
      });
    }
    const exchange = new DefaultExchange(this.ctx, {
      body,
      ...(headers !== undefined && { headers }),
    });
    const result = await channel.send(sanitized, exchange);
    return (result as Exchange).body as R;
  }
}
