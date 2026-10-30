// @routecraft/os -- system-native host capabilities.
// Current member: shell (isolated subprocess execution). Planned: host
// primitives such as clipboard, notifications, and process management.
// See .standards/package-boundaries.md.

// Side-effect import: claims the OS error namespace before any adapter here
// can throw one of its codes.
import "./errors.ts";

export {
  shell,
  SHELL,
  shellPlugin,
  untrusted,
  type IsolationName,
  type ShellArg,
  type ShellArgs,
  type ShellMount,
  type ShellOptions,
  type ShellPluginOptions,
  type ShellResult,
  type UntrustedArg,
} from "./adapters/shell/index.ts";
