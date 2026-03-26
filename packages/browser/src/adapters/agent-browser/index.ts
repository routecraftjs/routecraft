import type { Destination } from "@routecraft/routecraft";
import type {
  AgentBrowserCommand,
  AgentBrowserBaseOptions,
  AgentBrowserCommandMap,
  AgentBrowserResult,
  AgentBrowserOptionsMerged,
} from "./types.ts";
import { AgentBrowserDestinationAdapter } from "./destination.ts";

/**
 * Creates a browser destination adapter using the agent-browser library.
 * Session is derived from exchange.id so split/aggregate get isolated sessions.
 * Use with `.to()`, `.enrich()`, or `.tap()`. Requires `agent-browser` as a dependency.
 *
 * @experimental
 * @param command - Agent-browser command (e.g. `open`, `click`, `snapshot`, `get`)
 * @param options - Command-specific options plus base options (session, headed, timeout, json)
 * @returns A Destination that runs the command and returns `{ stdout, parsed?, exitCode }`
 *
 * @example
 * ```typescript
 * .to(agentBrowser('open', { url: (ex) => ex.body.url }))
 * .tap(agentBrowser('snapshot', { json: true }))
 * .enrich(agentBrowser('get', { info: 'text', selector: 'h1' }), only((r) => r.stdout, 'title'))
 * ```
 */
export function agentBrowser<
  T = unknown,
  C extends AgentBrowserCommand = AgentBrowserCommand,
>(
  command: C,
  options?: AgentBrowserCommandMap<T>[C] & AgentBrowserBaseOptions<T>,
): Destination<T, AgentBrowserResult> {
  return new AgentBrowserDestinationAdapter<T, C>(
    command,
    (options ?? {}) as AgentBrowserOptionsMerged<T, C>,
  );
}

// Re-export types for public API
export type {
  AgentBrowserBaseOptions,
  AgentBrowserCommandMap,
  AgentBrowserCommand,
  AgentBrowserResult,
} from "./types.ts";

// Re-export sanitizeSessionId for testing
export { sanitizeSessionId } from "./shared.ts";
