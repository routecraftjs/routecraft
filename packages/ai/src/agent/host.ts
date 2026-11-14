import {
  applicationState,
  type ApplicationKey,
  type Authority,
  type EventDetailsMap,
  type EventName,
  type Logger,
  type PortLookup,
} from "@routecraft/routecraft";
import type { ToolHost } from "./tools/types.ts";

/**
 * What the agent runtime holds for every dispatch in its application: its
 * logger, its event bus and the routes its tools reach. Kept beside the
 * `AGENTS` port rather than on it, because none of it is part of what a
 * provider of the registry promises.
 *
 * @internal
 */
export interface AgentRuntimeHost {
  /** The application, for a cache or a report-once set that belongs to it. */
  readonly application: ApplicationKey;
  readonly logger: Logger;
  emit<K extends EventName>(event: K, details: EventDetailsMap[K]): void;
  readonly tools: ToolHost;
}

/**
 * What one agent dispatch reads the application through: the runtime's
 * host, and the ports and settings of the application the dispatching
 * exchange runs in. An agent step is handed no context; it finds the agent
 * runtime through the exchange and builds this from it.
 */
export interface AgentHost extends AgentRuntimeHost, PortLookup {
  /** The application's authority, which reads and stamps principals. */
  readonly authority: Authority;
  /** Whether the application sends trace context on outbound calls by default. */
  readonly outboundTraceContext: boolean;
}

/** The agent runtime's host in each application, set when it binds. @internal */
export const agentHosts = applicationState<AgentRuntimeHost>();

/**
 * The host of one dispatch, from the runtime's host and what the dispatch
 * reads of its own application.
 *
 * @internal
 */
export function agentHostFor(
  runtime: AgentRuntimeHost,
  from: PortLookup,
  authority: Authority,
  outboundTraceContext: boolean,
): AgentHost {
  return {
    ...runtime,
    lookup: (port) => from.lookup(port),
    authority,
    outboundTraceContext,
  };
}
