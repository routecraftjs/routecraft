// @routecraft/os -- system-native host capabilities.
// Current members: agentBrowser (browser automation). Planned: shell
// (sandboxed by default), sandbox, and host primitives such as clipboard,
// notifications, and process management. See .standards/package-boundaries.md.

export {
  agentBrowser,
  type AgentBrowserBaseOptions,
  type AgentBrowserCommandMap,
  type AgentBrowserCommand,
  type AgentBrowserResult,
} from "./adapters/agent-browser/index.ts";
