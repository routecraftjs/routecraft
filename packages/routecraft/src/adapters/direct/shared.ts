import type { CraftContext } from "../../context";
import { registerCapability, type Capability } from "../../capabilities";
import { rcError } from "../../error";
import type { RouteDiscovery } from "../../route";
import type { DirectChannel, DirectBaseOptions } from "./types";
import type { Exchange } from "../../exchange";
import { DIRECT } from "../../kernel/direct.ts";

/**
 * Get or create the direct channel for the given endpoint.
 *
 * The channel type is the adapter's own when it set one, else the
 * application-wide `CraftConfig.direct` default, else in-memory.
 *
 * @param context - The CraftContext
 * @param endpoint - The sanitized endpoint name
 * @param options - Per-adapter options that may contain a custom channel type
 * @returns The DirectChannel instance for this endpoint
 * @throws RC1104 when the context has not installed its plugins
 * @internal
 */
export function getDirectChannel<T>(
  context: CraftContext,
  endpoint: string,
  options: Partial<DirectBaseOptions>,
): DirectChannel<Exchange<T>> {
  return context
    .require(DIRECT)
    .channel(endpoint, options.channelType) as DirectChannel<Exchange<T>>;
}

/**
 * Register the route as a discoverable capability. The metadata comes
 * from the route's discovery bundle (set via `.title()` /
 * `.description()` / `.input()` / `.output()` on the builder); direct
 * itself carries no discovery fields on its own options. Writes into the
 * core-owned capability registry keyed by the RAW endpoint id; the
 * sanitised channel key stays a transport detail of this adapter.
 *
 * @returns The disposer {@link registerCapability} minted, which the
 *   source calls when the route stops so the registry stops advertising
 *   an endpoint nothing answers on.
 */
export function registerRoute(
  context: CraftContext,
  endpoint: string,
  discovery?: RouteDiscovery,
): () => void {
  const capability: Capability = { endpoint };
  if (discovery?.title !== undefined) capability.title = discovery.title;
  if (discovery?.description !== undefined) {
    capability.description = discovery.description;
  }
  if (discovery?.input !== undefined) capability.input = discovery.input;
  if (discovery?.output !== undefined) capability.output = discovery.output;
  if (discovery?.tags !== undefined && discovery.tags.length > 0) {
    capability.tags = [...discovery.tags];
  }
  const dispose = registerCapability(context, capability);

  context.logger.debug(
    { endpoint, adapter: "direct" },
    "Registered direct route as a discoverable capability",
  );

  return dispose;
}

export { sanitizeEndpoint } from "../../kernel/direct.ts";

/**
 * Default in-memory implementation of DirectChannel.
 *
 * IMPORTANT: This implements single-consumer semantics where only the
 * last route to subscribe to an endpoint will receive messages.
 * Previous subscribers are automatically replaced (last one wins).
 *
 * Exported for the remotes plugin, which hands one to a local route that
 * subscribes onto an endpoint a remote already holds.
 *
 * @internal
 */
export class InMemoryDirectChannel<T> implements DirectChannel<T> {
  private handler: ((message: T) => Promise<T>) | null = null;

  async send(endpoint: string, message: T): Promise<T> {
    if (this.handler) {
      // Synchronous behavior - single consumer gets the message and we wait for result
      return await this.handler(message);
    }
    throw rcError("RC5004", undefined, {
      message: `No handler subscribed on direct endpoint "${endpoint}"; route may have stopped or was never started`,
    });
  }

  async subscribe(
    _context: CraftContext,
    _endpoint: string,
    handler: (message: T) => Promise<T>,
  ): Promise<void> {
    // Single consumer - only one handler allowed
    // This replaces any existing handler (last subscriber wins)
    this.handler = handler;
  }

  async unsubscribe(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _context: CraftContext,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _endpoint: string,
  ): Promise<void> {
    this.handler = null;
  }
}
