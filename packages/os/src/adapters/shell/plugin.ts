import type { CraftContext, CraftPlugin } from "@routecraft/routecraft";
import type { IsolationName } from "./types.ts";

/**
 * Context-wide defaults for `shell()`.
 *
 * The lowest layer of the three: a call site beats the
 * `ROUTECRAFT_SHELL_ISOLATION` operator override, which beats these. Deployment
 * policy belongs here, so a project can set its posture once instead of
 * repeating it at every call.
 */
export interface ShellPluginOptions {
  /** Isolation tier for calls that do not choose one. */
  isolation?: IsolationName;
  /** Default milliseconds before a command is killed. */
  timeout?: number;
  /** Default cap on captured output, per stream, in bytes. */
  maxOutputBytes?: number;
}

/**
 * Context store holding {@link ShellPluginOptions}.
 *
 * @internal
 */
export const SHELL_DEFAULTS = Symbol.for("routecraft.os.shell.defaults");

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [SHELL_DEFAULTS]: ShellPluginOptions;
  }
}

/**
 * Register context-wide defaults for `shell()`.
 *
 * Deliberately carries no `network` or `mapRootUser` default. Both widen
 * what a command may do, and a context-level default that widens is the
 * kind of grant nobody reads: whether a given command may reach the
 * network is a property of that command, so it is stated where the command
 * is written.
 *
 * @example
 * ```typescript
 * plugins: [shellPlugin({ timeout: 30_000 })]
 * ```
 */
export function shellPlugin(options: ShellPluginOptions = {}): CraftPlugin {
  return {
    name: "shell",
    apply(ctx: CraftContext) {
      ctx.setStore(SHELL_DEFAULTS, { ...options });
    },
  };
}
