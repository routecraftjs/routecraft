import type { Destination, Exchange } from "@routecraft/routecraft";
import type {
  AgentBrowserCommand,
  AgentBrowserResult,
  AgentBrowserOptionsMerged,
} from "./types.ts";
import {
  resolve,
  sanitizeSessionId,
  buildLibraryCommand,
  getOrCreateManager,
  dataToStdout,
  deleteSessionManager,
} from "./shared.ts";
import { executeCommand } from "agent-browser/dist/actions.js";

/**
 * AgentBrowserDestinationAdapter implements the Destination interface for browser automation.
 * Uses the agent-browser library to execute commands against a browser session.
 */
export class AgentBrowserDestinationAdapter<
  T = unknown,
  C extends AgentBrowserCommand = AgentBrowserCommand,
> implements Destination<T, AgentBrowserResult> {
  readonly adapterId = "routecraft.adapter.agent-browser";

  constructor(
    private readonly command: C,
    private readonly options: AgentBrowserOptionsMerged<
      T,
      C
    > = {} as AgentBrowserOptionsMerged<T, C>,
  ) {}

  async send(exchange: Exchange<T>): Promise<AgentBrowserResult> {
    const session =
      resolve(this.options.session, exchange) ?? sanitizeSessionId(exchange.id);
    const headed = this.options.headed ?? false;

    const resolved: Record<string, unknown> = {};
    const raw = this.options as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (
        key === "session" ||
        key === "headed" ||
        key === "timeout" ||
        key === "json" ||
        key === "args"
      )
        continue;
      const v = raw[key];
      if (typeof v === "function")
        (resolved as Record<string, unknown>)[key] = (
          v as (e: Exchange<T>) => unknown
        )(exchange);
      else resolved[key] = v;
    }

    const cmds = buildLibraryCommand(exchange.id, this.command, resolved);
    if (cmds.length === 0) {
      return { stdout: "", exitCode: 0 };
    }

    const manager = await getOrCreateManager(session, headed);

    try {
      let lastData: Record<string, unknown> = {};
      for (const cmd of cmds) {
        const response = await executeCommand(
          cmd as Parameters<typeof executeCommand>[0],
          manager,
        );
        const res = response as {
          success: boolean;
          data?: Record<string, unknown>;
          error?: string;
        };
        if (!res.success) {
          return {
            stdout: res.error ?? "Unknown error",
            exitCode: 1,
          };
        }
        if (res.data) lastData = res.data;
      }

      if (this.command === "close" && typeof manager.close === "function") {
        await manager.close().catch(() => {});
      }
      const stdout = dataToStdout(lastData);
      const result: AgentBrowserResult = { stdout, exitCode: 0 };
      if (this.options.json) {
        result.parsed = lastData;
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { stdout: message, exitCode: 1 };
    } finally {
      if (this.command === "close") {
        deleteSessionManager(session);
      }
    }
  }
}
