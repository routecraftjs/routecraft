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

/** The package a missing peer is reported as, in one place. */
const ACP_PACKAGE = "@agentclientprotocol/sdk";

/** The protocol surface: `agent()`, the method constants, the schema types. */
export function loadAcpSdk(
  consumer: string,
): Promise<typeof import("@agentclientprotocol/sdk")> {
  return loadOptionalPeer(() => import("@agentclientprotocol/sdk"), {
    consumer,
    packageName: ACP_PACKAGE,
  });
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
