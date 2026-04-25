import {
  ADAPTER_DIRECT_REGISTRY,
  DefaultExchange,
  getDirectChannel,
  rcError,
  type CraftContext,
  type DirectRouteMetadata,
  type Exchange,
  type Tag,
} from "@routecraft/routecraft";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { FnHandlerContext, FnOptions } from "../../fn/types.ts";
import { DEFERRED_FN_BRAND, type DeferredFn } from "./types.ts";

/**
 * Per-call overrides accepted by the builder helpers. Lets the caller
 * narrow the underlying tool's surface to a specific agent without
 * touching the underlying registration.
 *
 * @experimental
 */
export interface ToolBuilderOverrides<TIn = unknown, TOut = unknown> {
  /** Replace the underlying description shown to the LLM. */
  description?: string;
  /**
   * Replace the underlying input schema. Replaces, does not merge with,
   * the underlying schema.
   */
  schema?: StandardSchemaV1<unknown, TIn>;
  /**
   * Replace the underlying tags. Replaces, does not merge with, the
   * underlying tags.
   */
  tags?: Tag[];
  /**
   * Optional guard that runs after schema validation but before the
   * underlying handler. Throwing inside the guard surfaces back to the
   * LLM as a tool error so the model can self-correct.
   */
  guard?: (input: TIn, ctx: FnHandlerContext) => void | Promise<void>;
  /**
   * Override the handler return type at the type level. Rarely needed;
   * provided so callers can narrow `unknown`.
   */
  handler?: (input: TIn, ctx: FnHandlerContext) => Promise<TOut> | TOut;
}

/**
 * Wrap a registered direct route as a fn-shaped tool. The route's
 * `.description()`, `.input()` schema, and tags become the fn's
 * description, schema, and tags by default; pass `overrides` to narrow
 * any of them for the calling agent.
 *
 * Resolution is deferred to agent dispatch time, when the direct
 * registry is populated. Errors at resolution (unknown route id,
 * missing description, missing input schema) throw `RC5003`.
 *
 * @experimental
 *
 * @example
 * ```ts
 * agentPlugin({
 *   functions: {
 *     fetchOrder: directTool("fetch-order"),
 *     safeFetchOrder: directTool("fetch-order", {
 *       description: "Read-only order fetch.",
 *       tags: ["read-only"],
 *     }),
 *   },
 * });
 * ```
 */
export function directTool<TIn = unknown, TOut = unknown>(
  routeId: string,
  overrides?: ToolBuilderOverrides<TIn, TOut>,
): DeferredFn {
  if (typeof routeId !== "string" || routeId.trim() === "") {
    throw rcError("RC5003", undefined, {
      message: `directTool: routeId must be a non-empty string.`,
    });
  }
  return {
    [DEFERRED_FN_BRAND]: true,
    kind: "direct",
    targetId: routeId,
    resolve(ctx, fnId): FnOptions {
      const route = readDirectRoute(ctx, routeId, fnId);
      const description = overrides?.description ?? route.description;
      if (typeof description !== "string" || description.trim() === "") {
        throw rcError("RC5003", undefined, {
          message: `directTool: route "${routeId}" has no .description() and no override was provided (referenced as fn "${fnId}").`,
        });
      }
      const schema =
        overrides?.schema ??
        (route.input?.body as StandardSchemaV1<unknown, TIn> | undefined);
      if (!schema) {
        throw rcError("RC5003", undefined, {
          message: `directTool: route "${routeId}" has no .input(...) schema and no override was provided (referenced as fn "${fnId}").`,
        });
      }
      const tags = overrides?.tags ?? route.tags;
      const handler =
        overrides?.handler ??
        (((input, hctx) =>
          dispatchDirect<TIn, TOut>(hctx, routeId, input)) as FnOptions<
          TIn,
          TOut
        >["handler"]);
      return {
        description,
        schema,
        ...(tags && tags.length > 0 ? { tags } : {}),
        handler,
      } as FnOptions;
    },
  };
}

function readDirectRoute(
  ctx: CraftContext,
  routeId: string,
  fnId: string,
): DirectRouteMetadata {
  const registry = ctx.getStore(ADAPTER_DIRECT_REGISTRY) as
    | Map<string, DirectRouteMetadata>
    | undefined;
  const route = registry?.get(routeId);
  if (!route) {
    const known = registry ? [...registry.keys()].sort() : [];
    throw rcError("RC5003", undefined, {
      message:
        `directTool: unknown direct route id "${routeId}" (referenced as fn "${fnId}"). ` +
        (known.length > 0
          ? `Known route ids: ${known.join(", ")}.`
          : `No direct routes are registered in this context.`),
    });
  }
  return route;
}

async function dispatchDirect<TIn, TOut>(
  hctx: FnHandlerContext,
  routeId: string,
  input: TIn,
): Promise<TOut> {
  if (!hctx.context) {
    throw rcError("RC5003", undefined, {
      message: `directTool: no CraftContext available on the handler context (cannot dispatch to direct route "${routeId}").`,
    });
  }
  const exchange = new DefaultExchange<TIn>(hctx.context, { body: input });
  const channel = getDirectChannel<TIn>(hctx.context, routeId, {});
  const result = (await channel.send(
    routeId,
    exchange,
  )) as unknown as Exchange<TOut>;
  return result.body;
}

/**
 * Wrap a registered agent as a fn-shaped tool. Lands in story F (sub-
 * agents). Available now as a builder so the prefix auto-resolution
 * path in `tools(...)` can recognise `agent_*` and emit a clear "not
 * supported yet" error rather than treating the name as an unknown fn.
 *
 * @experimental
 */
export function agentTool(
  agentId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- shape mirrors the future story F signature
  _overrides?: never,
): DeferredFn {
  if (typeof agentId !== "string" || agentId.trim() === "") {
    throw rcError("RC5003", undefined, {
      message: `agentTool: agentId must be a non-empty string.`,
    });
  }
  return {
    [DEFERRED_FN_BRAND]: true,
    kind: "agent",
    targetId: agentId,
    resolve(_ctx, fnId): FnOptions {
      throw rcError("RC5003", undefined, {
        message: `agentTool("${agentId}") (referenced as fn "${fnId}") is not yet supported. Sub-agent tools land in a follow-up story.`,
      });
    },
  };
}

/**
 * Wrap an MCP tool as a fn-shaped tool. Lands in story E (MCP tools).
 * Available now as a builder so the prefix auto-resolution path in
 * `tools(...)` can recognise `mcp_*` and emit a clear "not supported
 * yet" error.
 *
 * @experimental
 */
export function mcpTool(
  serverId: string,
  toolName: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- shape mirrors the future story E signature
  _overrides?: never,
): DeferredFn {
  if (typeof serverId !== "string" || serverId.trim() === "") {
    throw rcError("RC5003", undefined, {
      message: `mcpTool: serverId must be a non-empty string.`,
    });
  }
  if (typeof toolName !== "string" || toolName.trim() === "") {
    throw rcError("RC5003", undefined, {
      message: `mcpTool: toolName must be a non-empty string.`,
    });
  }
  return {
    [DEFERRED_FN_BRAND]: true,
    kind: "mcp",
    targetId: `${serverId}:${toolName}`,
    resolve(_ctx, fnId): FnOptions {
      throw rcError("RC5003", undefined, {
        message: `mcpTool("${serverId}", "${toolName}") (referenced as fn "${fnId}") is not yet supported. MCP tools land in a follow-up story.`,
      });
    },
  };
}

/**
 * Small starter set of generic, broadly useful fns. Spread into your
 * `agentPlugin({ functions: { ... } })` config to give every agent in
 * the context the basics for free.
 *
 * @experimental
 *
 * @example
 * ```ts
 * agentPlugin({
 *   functions: {
 *     ...defaultFns,
 *     fetchOrder: directTool("fetch-order"),
 *   },
 * });
 * ```
 */
export const defaultFns = {
  currentTime: {
    description: "Returns the current UTC timestamp in ISO 8601 format.",
    schema: z.object({}),
    handler: () => new Date().toISOString(),
    tags: ["read-only", "idempotent"],
  } satisfies FnOptions<Record<string, never>, string>,
  randomUuid: {
    description: "Generates a fresh random UUID v4.",
    schema: z.object({}),
    handler: () => randomUUID(),
    tags: ["read-only"],
  } satisfies FnOptions<Record<string, never>, string>,
} as const;
