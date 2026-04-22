import {
  type ExchangeHeaders,
  type Exchange,
  HeadersKeys,
} from "../../exchange";
import type { Source } from "../../operations/from";
import type { CraftContext } from "../../context";
import { rcError, formatSchemaIssues } from "../../error";
import type { EventName } from "../../types";
import type { DirectServerOptions } from "./types";
import { getDirectChannel, registerRoute, sanitizeEndpoint } from "./shared";

/**
 * DirectSourceAdapter implements the Source interface for the direct adapter.
 *
 * This adapter is used when direct() is called with two arguments:
 * - `direct(endpoint, options)` where options can be `{}` or contain schema/description
 *
 * It subscribes to incoming messages on a specific endpoint and validates them
 * using the provided schema and headerSchema (if any).
 */
export class DirectSourceAdapter<T = unknown> implements Source<T> {
  readonly adapterId: string = "routecraft.adapter.direct";

  private endpoint: string;
  public options: Partial<DirectServerOptions>;

  constructor(endpoint: string, options: Partial<DirectServerOptions> = {}) {
    if (typeof endpoint !== "string") {
      throw rcError("RC5003", undefined, {
        message: "DirectSourceAdapter requires a string endpoint",
        suggestion:
          'Direct adapter with function endpoint can only be used with .to() or .tap(), not .from(). Use .from(direct("endpoint", {})) for source.',
      });
    }
    this.endpoint = endpoint;
    this.options = options;
  }

  async subscribe(
    context: CraftContext,
    handler: (message: T, headers?: ExchangeHeaders) => Promise<Exchange>,
    abortController: AbortController,
    onReady?: () => void,
  ): Promise<void> {
    // Sanitize the endpoint name
    const endpoint = sanitizeEndpoint(this.endpoint);

    // Register route in the registry
    registerRoute(context, endpoint, this.options);

    context.logger.debug(
      { endpoint, adapter: "direct" },
      "Setting up subscription for direct endpoint",
    );

    const channel = getDirectChannel<T>(context, endpoint, this.options);

    if (abortController.signal.aborted) {
      context.logger.debug(
        { endpoint, adapter: "direct" },
        "Subscription aborted for direct endpoint",
      );
      return;
    }

    // Wrap handler with validation if schema provided
    const wrappedHandler = this.hasValidation()
      ? this.createValidatedHandler(handler, endpoint, context)
      : async (exchange: Exchange<T>) => {
          const result = await handler(exchange.body as T, exchange.headers);
          return result as Exchange<T>;
        };

    // Set up cleanup on abort before subscribing
    abortController.signal.addEventListener(
      "abort",
      () => {
        channel.unsubscribe(context, endpoint).catch((err) => {
          context.logger.error(
            { err, adapter: "direct", endpoint, operation: "unsubscribe" },
            "Failed to unsubscribe from direct endpoint during abort",
          );
        });
      },
      { once: true },
    );

    // Set up the subscription
    await channel.subscribe(context, endpoint, wrappedHandler);

    onReady?.();

    // Keep the route "running" until the context stops (abort). Otherwise the context
    // would see all routes complete and auto-stop, e.g. before MCP can serve tool calls.
    await new Promise<void>((resolve) => {
      if (abortController.signal.aborted) {
        resolve();
        return;
      }
      abortController.signal.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
  }

  /**
   * Check if this adapter has validation configured
   */
  private hasValidation(): boolean {
    return !!(this.options.input?.body || this.options.input?.headers);
  }

  /**
   * Create handler that validates body and headers before calling actual handler.
   * Uses validated/coerced values if schema transforms them.
   */
  private createValidatedHandler(
    handler: (message: T, headers?: ExchangeHeaders) => Promise<Exchange>,
    endpoint: string,
    context: CraftContext,
  ): (exchange: Exchange<T>) => Promise<Exchange<T>> {
    return async (exchange: Exchange<T>) => {
      let validatedBody = exchange.body;
      let validatedHeaders = exchange.headers;

      const bodySchema = this.options.input?.body;
      if (bodySchema) {
        let result = bodySchema["~standard"].validate(exchange.body);
        if (result instanceof Promise) result = await result;

        const bodyIssues = (result as { issues?: unknown }).issues;
        if (bodyIssues !== undefined && bodyIssues !== null) {
          const err = rcError(
            "RC5002",
            new Error(formatSchemaIssues(bodyIssues)),
            {
              message: `Body validation failed for direct route "${endpoint}"`,
            },
          );
          this.emitValidationFailure(context, endpoint, exchange, err);
          throw err;
        }

        // Use validated/coerced value if schema transformed it
        const bodyValue = (result as { value?: T }).value;
        if (bodyValue !== undefined) {
          validatedBody = bodyValue;
        }
      }

      const headerSchema = this.options.input?.headers;
      if (headerSchema) {
        let result = headerSchema["~standard"].validate(exchange.headers);
        if (result instanceof Promise) result = await result;

        const headerIssues = (result as { issues?: unknown }).issues;
        if (headerIssues !== undefined && headerIssues !== null) {
          const err = rcError(
            "RC5002",
            new Error(formatSchemaIssues(headerIssues)),
            {
              message: `Header validation failed for direct route "${endpoint}"`,
            },
          );
          this.emitValidationFailure(context, endpoint, exchange, err);
          throw err;
        }

        // Merge validated/coerced headers over the original headers so that
        // user-supplied pass-through keys (correlation IDs, adapter-injected
        // metadata) survive schemas like `z.object()` that strip unknowns.
        const headerValue = (result as { value?: ExchangeHeaders }).value;
        if (headerValue !== undefined) {
          validatedHeaders = { ...exchange.headers, ...headerValue };
        }
      }

      // Create exchange with validated values
      const validatedExchange = {
        ...exchange,
        body: validatedBody,
        headers: validatedHeaders,
      } as Exchange<T>;

      // Call original handler with validated data
      return handler(
        validatedExchange.body as T,
        validatedExchange.headers,
      ) as Promise<Exchange<T>>;
    };
  }

  /**
   * Emit exchange:started and exchange:dropped events for pre-pipeline
   * validation errors. Uses "dropped" (not "failed") because the exchange
   * was rejected before entering the route handler, similar to a filter.
   */
  private emitValidationFailure(
    context: CraftContext,
    endpoint: string,
    exchange: Exchange<T>,
    error: unknown,
  ): void {
    // Use the endpoint name as routeId so the exchange appears under the
    // correct route in telemetry. The exchange header contains a random UUID
    // (set by DefaultExchange) because validation runs before the route
    // handler assigns the real route ID.
    const routeId = endpoint;
    const correlationId = (exchange.headers[HeadersKeys.CORRELATION_ID] ??
      exchange.id) as string;

    context.emit(`route:${routeId}:exchange:started` as EventName, {
      routeId,
      exchangeId: exchange.id,
      correlationId,
    });

    const reason =
      error instanceof Error
        ? `input validation failed: ${error.cause instanceof Error ? error.cause.message : error.message}`
        : "input validation failed";

    context.emit(`route:${routeId}:exchange:dropped` as EventName, {
      routeId,
      exchangeId: exchange.id,
      correlationId,
      reason,
      exchange,
    });
  }
}
