/**
 * Optional-peer loaders for the Agent Client Protocol SDK.
 *
 * Every load site goes through here rather than restating the
 * `loadOptionalPeer` incantation with its own package name, so the install
 * hint stays one sentence written once. The SDK splits its server transport
 * behind an `experimental/` subpath, and both entries resolve from the same
 * package, so a consumer is told to install one thing.
 *
 * @see https://agentclientprotocol.com
 */
import { loadOptionalPeer } from "@routecraft/routecraft";

/**
 * The package a missing peer is reported as, in one place.
 *
 * The bare package rather than the subpath the transport lives behind: it
 * is what somebody can actually install, and both entries resolve from it,
 * so a consumer is told to add one thing.
 *
 * @internal
 */
export const ACP_PACKAGE = "@agentclientprotocol/sdk";

/** The protocol surface: `agent()`, the method constants, the schema types. */
export function loadAcpSdk(
  consumer: string,
): Promise<typeof import("@agentclientprotocol/sdk")> {
  return loadOptionalPeer(() => import("@agentclientprotocol/sdk"), {
    consumer,
    packageName: ACP_PACKAGE,
  });
}

/**
 * The protocol's generated JSON Schema, which the surface's checks are
 * built from. A subpath of the same package, so the same install hint.
 */
export function loadAcpSchema(consumer: string): Promise<unknown> {
  return loadOptionalPeer(
    () =>
      import("@agentclientprotocol/sdk/schema/schema.json", {
        with: { type: "json" },
      }).then((module) => module.default),
    { consumer, packageName: ACP_PACKAGE },
  );
}

/** The Streamable HTTP server transport: `AcpServer`. */
export function loadAcpServerSdk(
  consumer: string,
): Promise<typeof import("@agentclientprotocol/sdk/experimental/server")> {
  return loadOptionalPeer(
    () => import("@agentclientprotocol/sdk/experimental/server"),
    { consumer, packageName: ACP_PACKAGE },
  );
}
