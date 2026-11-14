import { afterAll, mock } from "bun:test";

/**
 * Drive the real MCP client SDK in the calling suite. Another suite in the
 * same process may have replaced the SDK loader with a mock client, and
 * `mock.module` outlives the suite that set it, so this puts the real
 * loader back and hands back whatever loader it found once the suite is
 * done. Call it at the top of the test file, before any test runs.
 *
 * @returns The SDK seam as it was found, for a suite that calls it directly.
 */
export async function useRealMcpSdk(): Promise<
  typeof import("../../src/mcp/sdk.ts")
> {
  const sdk = await import("../../src/mcp/sdk.ts");
  const prior = { ...sdk };
  mock.module("../../src/mcp/sdk.ts", () => ({
    ...prior,
    loadMcpClientSdk: async () => import("@modelcontextprotocol/client"),
  }));
  afterAll(() => {
    mock.module("../../src/mcp/sdk.ts", () => prior);
  });
  return prior;
}
