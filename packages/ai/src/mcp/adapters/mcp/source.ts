import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  formatSchemaIssues,
  HeadersKeys,
  rcError,
  sanitizeEndpoint,
  type CraftContext,
  type EventName,
  type Exchange,
  type ExchangeHeaders,
  type Source,
} from "@routecraft/routecraft";
import {
  MCP_LOCAL_TOOL_REGISTRY,
  MCP_PLUGIN_REGISTERED,
  type McpLocalToolEntry,
  type McpServerOptions,
} from "../../types.ts";
import type { McpMessage } from "./types.ts";
import { BRAND_MCP_ADAPTER } from "./shared.ts";

/**
 * McpSourceAdapter implements the Source interface for the MCP adapter.
 *
 * Used when `mcp()` is called with two arguments as a source:
 * `mcp(endpoint, options)` where `options` contains a required `description`.
 *
 * The adapter owns its own registry ({@link MCP_LOCAL_TOOL_REGISTRY}) and
 * never delegates to the `direct()` adapter. This keeps `direct` routes and
 * `mcp` routes fully isolated: they can share the same endpoint string
 * without colliding, and direct routes never leak into MCP `tools/list`.
 *
 * @experimental
 */
export class McpSourceAdapter<
  S extends StandardSchemaV1 | undefined = undefined,
> implements Source<McpMessage<S>> {
  readonly adapterId: string = "routecraft.adapter.mcp";

  private endpoint: string;
  private options: McpServerOptions & { schema?: S };

  constructor(endpoint: string, options: McpServerOptions & { schema?: S }) {
    (this as unknown as Record<symbol, boolean>)[BRAND_MCP_ADAPTER] = true;

    if (typeof endpoint !== "string") {
      throw rcError("RC5003", undefined, {
        message: "Dynamic endpoints cannot be used as source",
        suggestion:
          "Use a static string endpoint for source: .from(mcp('endpoint', options)).",
      });
    }

    if ("url" in options || "serverId" in options) {
      throw rcError("RC5003", undefined, {
        message:
          "mcp() with url or serverId must be used as destination: .to(mcp({ url, tool }))",
        suggestion:
          "Use .to(mcp({ url: '...', tool: '...' })) to call a remote MCP server.",
      });
    }

    if (
      "args" in options &&
      (options as { args?: unknown }).args !== undefined &&
      !("description" in options)
    ) {
      throw rcError("RC5003", undefined, {
        message:
          "mcp(endpoint, { args }) is for client usage with a 'server:tool' target, not for defining a source",
        suggestion:
          "Use .to(mcp('server:tool', { args })) to call a remote tool, or .from(mcp('endpoint', { description: '...' })) to define a source.",
      });
    }

    if (
      !("description" in options) ||
      typeof options.description !== "string"
    ) {
      throw rcError("RC5003", undefined, {
        message:
          "mcp(endpoint, options) as source requires options.description",
        suggestion:
          "Use .from(mcp('endpoint', { description: '...' })) to define a source.",
      });
    }

    this.endpoint = endpoint;
    this.options = options;
  }

  async subscribe(
    context: CraftContext,
    handler: (
      message: McpMessage<S>,
      headers?: ExchangeHeaders,
    ) => Promise<Exchange>,
    abortController: AbortController,
    onReady?: () => void,
  ): Promise<void> {
    const registered = context.getStore(
      MCP_PLUGIN_REGISTERED as keyof import("@routecraft/routecraft").StoreRegistry,
    ) as boolean | undefined;
    if (registered !== true) {
      throw new Error(
        "MCP plugin required: routes using .from(mcp(...)) require the MCP plugin. Add mcpPlugin() to your config: plugins: [mcpPlugin()].",
      );
    }

    const endpoint = sanitizeEndpoint(this.endpoint);

    let registry = context.getStore(
      MCP_LOCAL_TOOL_REGISTRY as keyof import("@routecraft/routecraft").StoreRegistry,
    ) as Map<string, McpLocalToolEntry> | undefined;
    if (!registry) {
      registry = new Map<string, McpLocalToolEntry>();
      context.setStore(
        MCP_LOCAL_TOOL_REGISTRY as keyof import("@routecraft/routecraft").StoreRegistry,
        registry,
      );
    }

    if (registry.has(endpoint)) {
      throw rcError("RC5003", undefined, {
        message: `Duplicate MCP tool endpoint "${this.endpoint}": another .from(mcp(...)) route already registered this endpoint in the same context`,
        suggestion:
          "Each MCP tool endpoint must be unique within a context. Rename one of the mcp() routes to a different endpoint.",
      });
    }

    const entryHandler = this.createEntryHandler(handler, endpoint, context);

    const entry: McpLocalToolEntry = {
      endpoint,
      description: this.options.description,
      handler: entryHandler,
    };
    if (this.options.schema !== undefined) {
      entry.schema = this.options.schema;
    }
    if (this.options.keywords !== undefined) {
      entry.keywords = this.options.keywords;
    }
    if (this.options.annotations !== undefined) {
      entry.annotations = this.options.annotations;
    }

    if (abortController.signal.aborted) {
      return;
    }

    registry.set(endpoint, entry);

    abortController.signal.addEventListener(
      "abort",
      () => {
        const current = context.getStore(
          MCP_LOCAL_TOOL_REGISTRY as keyof import("@routecraft/routecraft").StoreRegistry,
        ) as Map<string, McpLocalToolEntry> | undefined;
        current?.delete(endpoint);
      },
      { once: true },
    );

    onReady?.();

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

  private createEntryHandler(
    handler: (
      message: McpMessage<S>,
      headers?: ExchangeHeaders,
    ) => Promise<Exchange>,
    endpoint: string,
    context: CraftContext,
  ): (exchange: Exchange) => Promise<Exchange> {
    return async (exchange: Exchange): Promise<Exchange> => {
      let validatedBody: unknown = exchange.body;
      let validatedHeaders: ExchangeHeaders = exchange.headers;

      if (this.options.schema) {
        let result = this.options.schema["~standard"].validate(exchange.body);
        if (result instanceof Promise) result = await result;

        const bodyIssues = (result as { issues?: unknown }).issues;
        if (bodyIssues !== undefined && bodyIssues !== null) {
          const err = rcError(
            "RC5002",
            new Error(formatSchemaIssues(bodyIssues)),
            {
              message: `Body validation failed for mcp route "${endpoint}"`,
            },
          );
          this.emitValidationFailure(context, endpoint, exchange, err);
          throw err;
        }

        const bodyValue = (result as { value?: unknown }).value;
        if (bodyValue !== undefined) {
          validatedBody = bodyValue;
        }
      }

      if (this.options.headerSchema) {
        let result = this.options.headerSchema["~standard"].validate(
          exchange.headers,
        );
        if (result instanceof Promise) result = await result;

        const headerIssues = (result as { issues?: unknown }).issues;
        if (headerIssues !== undefined && headerIssues !== null) {
          const err = rcError(
            "RC5002",
            new Error(formatSchemaIssues(headerIssues)),
            {
              message: `Header validation failed for mcp route "${endpoint}"`,
            },
          );
          this.emitValidationFailure(context, endpoint, exchange, err);
          throw err;
        }

        const headerValue = (result as { value?: ExchangeHeaders }).value;
        if (headerValue !== undefined) {
          validatedHeaders = headerValue;
        }
      }

      return handler(
        validatedBody as McpMessage<S>,
        validatedHeaders,
      ) as Promise<Exchange>;
    };
  }

  private emitValidationFailure(
    context: CraftContext,
    endpoint: string,
    exchange: Exchange,
    error: unknown,
  ): void {
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
