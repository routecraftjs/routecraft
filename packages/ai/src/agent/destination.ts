import type { Destination, Exchange } from "@routecraft/routecraft";
import { AgentRunner } from "./runner.ts";
import type { AgentOptions, AgentResult } from "./types.ts";

/** Validate modelId format "providerId:modelName". */
function validateModelId(modelId: string): void {
  const colon = modelId.indexOf(":");
  if (colon < 1 || colon === modelId.length - 1) {
    throw new Error(
      `Agent adapter: modelId must be "providerId:modelName" (e.g. ollama:llama3). Got: "${modelId}"`,
    );
  }
}

/**
 * Agent destination adapter.
 * Use via agent(); do not instantiate AgentRunner directly.
 *
 * @experimental
 */
export class AgentDestinationAdapter implements Destination<
  unknown,
  AgentResult
> {
  readonly adapterId = "routecraft.adapter.agent";

  private readonly runner: AgentRunner;

  constructor(options: AgentOptions) {
    validateModelId(options.modelId);
    this.runner = new AgentRunner(options);
  }

  async send(exchange: Exchange<unknown>): Promise<AgentResult> {
    return this.runner.run(exchange);
  }
}
