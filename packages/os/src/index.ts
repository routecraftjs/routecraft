// @routecraft/os -- system-native host capabilities.
// Current members: shell (isolated subprocess execution) and agentBrowser
// (browser automation). Planned: host primitives such as clipboard,
// notifications, and process management. See .standards/package-boundaries.md.

// Side-effect import: claims the OS error namespace before any adapter here
// can throw one of its codes.
import "./errors.ts";

export {
  agentBrowser,
  type AgentBrowserBaseOptions,
  type AgentBrowserCommandMap,
  type AgentBrowserCommand,
  type AgentBrowserResult,
} from "./adapters/agent-browser/index.ts";

export {
  shell,
  shellPlugin,
  untrusted,
  type IsolationName,
  type ShellArg,
  type ShellArgs,
  type ShellOptions,
  type ShellPluginOptions,
  type ShellResult,
  type UntrustedArg,
} from "./adapters/shell/index.ts";
