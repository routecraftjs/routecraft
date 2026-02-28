import type { Exchange } from "@routecraft/routecraft";
import type { AgentOptions, AgentResult } from "./types.ts";

/**
 * Internal runner for the agent loop. Phase 1: stub that passes through and returns
 * exchange body. Full implementation (LLM + tool dispatch) in Phase 2.
 */
export class AgentRunner {
  constructor(private readonly _options: AgentOptions) {}

  async run(exchange: Exchange<unknown>): Promise<AgentResult> {
    void this._options; // Phase 2 will use modelId, allowedRoutes, etc.
    // Phase 1: pass-through only
    if (exchange.logger) {
      exchange.logger.debug(
        { adapter: "agent" },
        "Agent pass-through — implementation pending",
      );
    }
    return {
      output: exchange.body,
      steps: 0,
    };
  }
}
