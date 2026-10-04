import type { Capability } from "../capabilities.ts";
import type { CraftContext } from "../context.ts";
import type { Exchange } from "../exchange.ts";
import { port } from "./port.ts";

/** Constructs the channel for one endpoint. */
export type DirectChannelType<T extends DirectChannel> = new (
  endpoint: string,
) => T;

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
 * Every direct endpoint of one application: the channels routes subscribe
 * on, the capabilities those endpoints advertise, and the endpoints that
 * declared themselves internal instead.
 *
 * Provided by the default-installed `routecraft.direct` plugin and reached
 * through {@link DIRECT}: the direct adapter, `CraftClient`,
 * `context.capabilities()` and the remotes plugin all read and write the
 * one registry, so a remote route installed here is indistinguishable from
 * a local one to every caller.
 */
export interface DirectRegistry {
  /** The application-wide channel type from `CraftConfig.direct`, when set. */
  readonly channelType: DirectChannelType<DirectChannel> | undefined;
  /**
   * The channel on a sanitised endpoint (see `sanitizeEndpoint`), without
   * creating one.
   */
  existing(key: string): DirectChannel<Exchange> | undefined;
  /**
   * Put a channel on a sanitised endpoint in place of whatever holds it:
   * how the remotes plugin answers an endpoint from another instance.
   */
  install(key: string, channel: DirectChannel<Exchange>): void;
  /**
   * Take back a channel {@link DirectRegistry.install} put on a sanitised
   * endpoint, while it still holds it: `restore` goes back in its place, or
   * the endpoint is left empty. A channel another install has displaced is
   * left alone.
   */
  uninstall(
    key: string,
    channel: DirectChannel<Exchange>,
    restore?: DirectChannel<Exchange>,
  ): void;
  /**
   * The channel on a sanitised endpoint, created on first use: of
   * `channelType` when given, else the application-wide type, else
   * in-memory.
   */
  channel(
    key: string,
    channelType?: DirectChannelType<DirectChannel>,
  ): DirectChannel<Exchange>;
  /**
   * Hand an exchange to the route listening on a raw endpoint and resolve
   * with what it produced. How the kernel forwards from an error handler
   * without knowing the transport.
   */
  send(endpoint: string, exchange: Exchange): Promise<Exchange>;
  /** The capability advertised on a raw endpoint, if any. */
  capability(endpoint: string): Capability | undefined;
  /** Every advertised capability, as registered. */
  capabilities(): IterableIterator<Capability>;
  /**
   * Advertise a capability on its raw endpoint.
   *
   * @returns A disposer that removes THIS registration while it still holds
   *   the endpoint, and nothing once another registration replaced it
   * @throws RC5003 when the endpoint declared itself internal
   */
  registerCapability(capability: Capability): () => void;
  /**
   * Mark a raw endpoint internal: composable in-process, never advertised.
   *
   * @returns A disposer with the same ownership rule as
   *   {@link DirectRegistry.registerCapability}'s
   * @throws RC5003 when the endpoint is already an advertised capability
   */
  registerInternal(endpoint: string): () => void;
  /** Whether a raw endpoint declared itself internal. */
  isInternal(endpoint: string): boolean;
}

/** The direct endpoint registry of an application. */
export const DIRECT = port<DirectRegistry>("routecraft.direct@1");
