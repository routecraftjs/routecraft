import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";

/**
 * A stateful remote MCP server reached through a stubbed `fetch`, with no
 * socket: each `initialize` opens a session, a request carrying an unknown
 * `Mcp-Session-Id` gets the 404 the spec prescribes, and {@link dropSessions}
 * forgets every session the way a restarted remote does. {@link failNextCall}
 * answers the next `tools/call` with a 500, and {@link forgetEverySession}
 * makes every session unknown from then on.
 */
export function statefulRemote(url: string) {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const counts = { initialize: 0, call: 0 };
  let failNext = false;
  let forgetAll = false;
  const original = globalThis.fetch;

  async function handle(request: Request): Promise<Response> {
    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId !== null) {
      const transport = forgetAll ? undefined : sessions.get(sessionId);
      if (!transport) return new Response("Session not found", { status: 404 });
      const body: unknown =
        request.method === "POST" ? await request.clone().json() : undefined;
      if ((body as { method?: string } | undefined)?.method === "tools/call") {
        counts.call++;
        if (failNext) {
          failNext = false;
          return new Response("Internal Server Error", { status: 500 });
        }
      }
      return transport.handleRequest(request);
    }
    const body: unknown =
      request.method === "POST" ? await request.clone().json() : undefined;
    if ((body as { method?: string } | undefined)?.method !== "initialize") {
      return new Response("Bad Request: no session", { status: 400 });
    }
    counts.initialize++;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
      },
    });
    const server = new McpServer({ name: "remote", version: "1.0.0" });
    server.registerTool("echo", { description: "Echo" }, async () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    await server.connect(transport);
    return transport.handleRequest(request);
  }

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (!request.url.startsWith(url)) return original(input, init);
    return handle(request);
  }) as typeof fetch;

  return {
    counts,
    dropSessions(): void {
      sessions.clear();
    },
    failNextCall(): void {
      failNext = true;
    },
    forgetEverySession(): void {
      forgetAll = true;
    },
    restore(): void {
      globalThis.fetch = original;
    },
  };
}
