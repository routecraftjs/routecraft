/**
 * Streamable HTTP response decoding shared by the MCP test suites.
 *
 * One MCP exchange comes back either as a plain JSON body (the 2026-07-28
 * path) or as an SSE frame (`event: message` + `data:`, which the 2025-era
 * stateless fallback uses). The framing is a property of the transport, not of
 * any one suite, so it is decoded in one place: three hand-rolled decoders had
 * already drifted on whether to join every `data:` line or only the first.
 */

/** Reduce a Streamable HTTP response body to its JSON-RPC payload. */
export function rpcBody(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.includes("data: ")) return trimmed;
  return trimmed
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))
    .join("");
}

/** The `result` member of a JSON-RPC response, whichever framing carried it. */
export function rpcResult(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(rpcBody(raw)) as {
    result?: Record<string, unknown>;
  };
  return parsed.result ?? {};
}
