import type { CraftContext } from "../../context";
import type { Exchange } from "../../exchange";
import type { RegisteredDirectEndpoint } from "../../registry";

/**
 * @deprecated Use `CraftConfig.direct` (a `Pick<DirectBaseOptions, "channelType">`) instead.
 * Previously a no-op placeholder (`Record<string, unknown>`), now removed.
 * This alias exists only for migration; it will be removed in the next major version.
 */
export type DirectConfig = Pick<DirectBaseOptions, "channelType">;

export type DirectChannelType<T extends DirectChannel> = new (
  endpoint: string,
) => T;

export type DirectEndpoint<T = unknown> =
  RegisteredDirectEndpoint | ((exchange: Exchange<T>) => string);

/**
 * DirectChannel interface for synchronous inter-route communication.
 *
 * Semantics:
 * - Single consumer per endpoint (last subscriber wins)
 * - Synchronous blocking behavior (sender waits for response)
 * - Point-to-point messaging (not pub/sub)
 */
export interface DirectChannel<T = unknown> {
  send(endpoint: string, message: T): Promise<T>;
  subscribe(
    context: CraftContext,
    endpoint: string,
    handler: (message: T) => Promise<T>,
  ): Promise<void>;
  unsubscribe(context: CraftContext, endpoint: string): Promise<void>;
}

/**
 * Base options shared between source and destination.
 */
export interface DirectBaseOptions {
  /** Custom channel implementation */
  channelType?: DirectChannelType<DirectChannel>;
}

/**
 * Options when using direct adapter as a Server (`.from()`).
 *
 * The shared discovery metadata (title, description, input, output) lives
 * on the route via `.title()` / `.description()` / `.input()` / `.output()`
 * and is enforced by the framework regardless of adapter.
 */
export interface DirectServerOptions extends DirectBaseOptions {
  /**
   * Close the route's external doors: it stays composable in-process
   * (`direct("id")` enrichers, `forward`) but is neither dispatchable
   * through the ops management API nor resolvable as an agent
   * `directTool`. For a subroutine that trusts its caller because a
   * boundary route carries `.input()`, `.description()` and
   * `.authorize()` for it. Defaults to false: a `direct()` route is a
   * capability, and capabilities are what `craft exec` runs.
   */
  internal?: boolean;
}

/**
 * Options when using direct adapter as a Client (`.to()`, `.tap()`).
 * Room for future options (e.g. timeout, retryPolicy).
 */
export type DirectClientOptions = DirectBaseOptions;

/**
 * Options when using direct as a server or client (union).
 */
export type DirectOptions = DirectServerOptions | DirectClientOptions;
