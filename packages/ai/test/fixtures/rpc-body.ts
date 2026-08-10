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
  // Decide framing from a line prefix, not a substring: a plain JSON body may
  // legitimately contain "data: " inside a string value. Split on CRLF too, so
  // a server that frames SSE with \r\n does not leave a stray \r mid-payload.
  const data = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"));
  if (data.length === 0) return trimmed;
  return data.map((line) => line.slice("data:".length).trimStart()).join("");
}

/** The `result` member of a JSON-RPC response, whichever framing carried it. */
export function rpcResult(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(rpcBody(raw)) as {
    result?: Record<string, unknown>;
    error?: { code?: number; message?: string };
  };
  // Surface a JSON-RPC error here rather than returning an empty object: a
  // protocol failure would otherwise read as an empty success at every caller.
  if (parsed.result === undefined && parsed.error) {
    throw new Error(
      `JSON-RPC error ${parsed.error.code ?? "?"}: ${parsed.error.message ?? "unknown"}`,
    );
  }
  return parsed.result ?? {};
}
