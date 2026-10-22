import { rpcBody } from "../fixtures/rpc-body.ts";

/** The `initialize` params of a 2025-era client, as every HTTP suite sends them. */
export const MCP_INIT_PARAMS = {
  protocolVersion: "2024-11-05" as const,
  capabilities: {},
  clientInfo: { name: "test", version: "1.0.0" },
};

/** One JSON-RPC POST to an MCP HTTP mount on the loopback listener. */
export async function postRpc(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; body: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text === "" ? "" : rpcBody(text),
  };
}

/**
 * Initialize against a mount and list its tools: the names on success, or
 * the first failing status.
 */
export async function listToolsOver(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; tools?: string[] | undefined }> {
  const init = await postRpc(
    port,
    path,
    { jsonrpc: "2.0", id: 1, method: "initialize", params: MCP_INIT_PARAMS },
    headers,
  );
  if (init.status !== 200) return { status: init.status };
  const listed = await postRpc(
    port,
    path,
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    headers,
  );
  if (listed.status !== 200) return { status: listed.status };
  const parsed = JSON.parse(listed.body) as {
    result?: { tools: Array<{ name: string }> };
  };
  return { status: 200, tools: parsed.result?.tools.map((tool) => tool.name) };
}
