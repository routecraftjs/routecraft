import type { Destination } from "@routecraft/routecraft";
import { AgentAdapter } from "./adapter.ts";
import type { AgentOptions, AgentResult } from "./types.ts";

/**
 * Create an agent destination.
 *
 * @param options Agent options (modelId, systemPrompt, allowedRoutes, etc.)
 * @returns Destination that produces AgentResult
 */
export function agent(
  options: AgentOptions,
): Destination<unknown, AgentResult> {
  return new AgentAdapter(options);
}
