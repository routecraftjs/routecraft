import {
  type ExchangeHeaders,
  type Exchange,
  HeadersKeys,
} from "../../exchange";
import type { Source } from "../../operations/from";
import type { CraftContext, MergedOptions } from "../../context";
import { rcError } from "../../error";
import type { EventName } from "../../types";
import type { DirectServerOptions } from "./types";
import type { DirectOptionsMerged } from "./shared";
import {
  getDirectChannel,
  getMergedOptions,
  registerRoute,
  sanitizeEndpoint,
} from "./shared";

/**
 * DirectSourceAdapter implements the Source interface for the direct adapter.
 *
 * This adapter is used when direct() is called with two arguments:
 * - `direct(endpoint, options)` where options can be `{}` or contain schema/description
 *
 * It subscribes to incoming messages on a specific endpoint and validates them
 * using the provided schema and headerSchema (if any).
 */
export class DirectSourceAdapter<T = unknown>
  implements Source<T>, MergedOptions<DirectOptionsMerged>
{
  readonly adapterId: string = "routecraft.adapter.direct";

  private endpoint: string;
  public options: Partial<DirectOptionsMerged>;

  constructor(endpoint: string, options: Partial<DirectServerOptions> = {}) {
    if (typeof endpoint !== "string") {
      throw rcError("RC5003", undefined, {
        message: "DirectSourceAdapter requires a string endpoint",
        suggestion:
          'Direct adapter with function endpoint can only be used with .to() or .tap(), not .from(). Use .from(direct("endpoint", {})) for source.',
      });
    }
    this.endpoint = endpoint;
    this.options = options as Partial<DirectOptionsMerged>;
  }

  async subscribe(
    context: CraftContext,
    handler: (message: T, headers?: ExchangeHeaders) => Promise<Exchange>,
    abortController: AbortController,
    onReady?: () => void,
  ): Promise<void> {
    // Sanitize the endpoint name
    const endpoint = sanitizeEndpoint(this.endpoint);

    // Get merged options from context store
    const merged = getMergedOptions(context, this.options);

    // Register route in the registry
    registerRoute(context, endpoint, merged);

    context.logger.debug(
      { endpoint, adapter: "direct" },
      "Setting up subscription for direct endpoint",
    );

    const channel = getDirectChannel<T>(context, endpoint, merged);

    if (abortController.signal.aborted) {
      context.logger.debug(
        { endpoint, adapter: "direct" },
        "Subscription aborted for direct endpoint",
      );
      return;
    }

    // Wrap handler with validation if schema provided
    const wrappedHandler = this.hasValidation(merged)
      ? this.createValidatedHandler(handler, endpoint, merged, context)
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

  mergedOptions(context: CraftContext): DirectOptionsMerged {
    return getMergedOptions(context, this.options);
  }

  /**
   * Check if this adapter has validation configured
   */
  private hasValidation(options: DirectOptionsMerged): boolean {
    return !!(options.schema || options.headerSchema);
  }

  /**
   * Create handler that validates body and headers before calling actual handler.
   * Uses validated/coerced values if schema transforms them.
   */
  private createValidatedHandler(
    handler: (message: T, headers?: ExchangeHeaders) => Promise<Exchange>,
    endpoint: string,
    options: DirectOptionsMerged,
    context: CraftContext,
  ): (exchange: Exchange<T>) => Promise<Exchange<T>> {
    return async (exchange: Exchange<T>) => {
      let validatedBody = exchange.body;
      let validatedHeaders = exchange.headers;

      // Validate body if schema provided
      if (options.schema) {
        let result = options.schema["~standard"].validate(exchange.body);
        if (result instanceof Promise) result = await result;

        const bodyIssues = (result as { issues?: unknown }).issues;
        if (bodyIssues !== undefined && bodyIssues !== null) {
          const causeMessage =
            typeof bodyIssues === "object"
              ? JSON.stringify(bodyIssues)
              : String(bodyIssues);
          const err = rcError("RC5002", new Error(causeMessage), {
            message: `Body validation failed for direct route "${endpoint}"`,
          });
          this.emitValidationFailure(context, endpoint, exchange, err);
          throw err;
        }

        // Use validated/coerced value if schema transformed it
        const bodyValue = (result as { value?: T }).value;
        if (bodyValue !== undefined) {
          validatedBody = bodyValue;
        }
      }

      // Validate headers if headerSchema provided
      if (options.headerSchema) {
        let result = options.headerSchema["~standard"].validate(
          exchange.headers,
        );
        if (result instanceof Promise) result = await result;

        const headerIssues = (result as { issues?: unknown }).issues;
        if (headerIssues !== undefined && headerIssues !== null) {
          const causeMessage =
            typeof headerIssues === "object"
              ? JSON.stringify(headerIssues)
              : String(headerIssues);
          const err = rcError("RC5002", new Error(causeMessage), {
            message: `Header validation failed for direct route "${endpoint}"`,
          });
          this.emitValidationFailure(context, endpoint, exchange, err);
          throw err;
        }

        // Use validated/coerced headers if schema transformed them
        const headerValue = (result as { value?: ExchangeHeaders }).value;
        if (headerValue !== undefined) {
          validatedHeaders = headerValue;
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
   * Emit exchange:started and exchange:failed events for pre-pipeline
   * validation errors. This ensures the failed exchange is recorded in
   * telemetry even though it never reached the route handler.
   */
  private emitValidationFailure(
    context: CraftContext,
    endpoint: string,
    exchange: Exchange<T>,
    error: unknown,
  ): void {
    const routeId = (exchange.headers[HeadersKeys.ROUTE_ID] ??
      endpoint) as string;
    const correlationId = (exchange.headers[HeadersKeys.CORRELATION_ID] ??
      exchange.id) as string;

    context.emit(`route:${routeId}:exchange:started` as EventName, {
      routeId,
      exchangeId: exchange.id,
      correlationId,
    });

    context.emit(`route:${routeId}:exchange:failed` as EventName, {
      routeId,
      exchangeId: exchange.id,
      correlationId,
      duration: 0,
      error,
    });
  }
}
