import {
  applicationState,
  type EventDetailsMap,
  type EventName,
  type PluginContext,
} from "@routecraft/routecraft";
import { declaredProxy } from "./proxy.ts";
import type { McpToolRegistryEntry } from "./types.ts";

/**
 * What the MCP plugin holds for its application beside the value of the
 * `MCP` port: the event bus a remote call is recorded on, and the reading of
 * the route definitions that tells a governed tool from an ungoverned one.
 * Kept off the port because neither is part of what a provider of `MCP`
 * promises.
 *
 * @internal
 */
export interface McpRuntime {
  emit<K extends EventName>(event: K, details: EventDetailsMap[K]): void;
  /**
   * The route whose source declares a proxy over a remote tool, live or
   * not. See {@link declaredProxy}.
   */
  declaredProxy(
    remote: McpToolRegistryEntry,
  ): { routeId: string; tool: string; excluded: boolean } | undefined;
}

/** The MCP runtime of each application, set when the MCP plugin binds. @internal */
export const mcpRuntime = applicationState<McpRuntime>();

/** @internal */
export function mcpRuntimeFor(
  c: Pick<PluginContext, "routes" | "emit">,
): McpRuntime {
  return {
    emit: (event, details) => c.emit(event, details),
    declaredProxy: (remote) => declaredProxy(c, remote),
  };
}
