import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";

/**
 * A stateful remote MCP server reached through a stubbed `fetch`, with no
 * socket. Each `initialize` opens a session, and a request carrying an
 * unknown `Mcp-Session-Id` gets the 404 the spec prescribes. It serves
 * `echo`, and `slow`, which answers once {@link releaseSlow} is called.
 *
 * Faults, each for the next `tools/call` unless said otherwise:
 * - {@link dropSessions} forgets every session, as a restarted remote does;
 * - {@link failNextCall} answers with HTTP 500;
 * - {@link throwNextCall} fails the request before any answer, as a refused
 *   socket does;
 * - {@link staleOnEveryCall} answers every `tools/call` from now on with the
 *   stale-session 404, while the handshake still succeeds.
 */
export function statefulRemote(url: string) {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const counts = { initialize: 0, call: 0, stale: 0, terminated: 0 };
  let failNext = false;
  let throwNext = false;
  let staleOnCall = false;
  let release: () => void = () => undefined;
  let slowGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = globalThis.fetch;

  async function methodOf(request: Request): Promise<string | undefined> {
    if (request.method !== "POST") return undefined;
    const body: unknown = await request.clone().json();
    return (body as { method?: string }).method;
  }

  async function handle(request: Request): Promise<Response> {
    const method = await methodOf(request);
    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId !== null) {
      if (request.method === "DELETE") counts.terminated++;
      const transport = sessions.get(sessionId);
      if (!transport) return new Response("Session not found", { status: 404 });
      if (method === "tools/call") {
        if (staleOnCall) {
          counts.stale++;
          return new Response("Session not found", { status: 404 });
        }
        if (throwNext) {
          throwNext = false;
          throw new TypeError("fetch failed");
        }
        counts.call++;
        if (failNext) {
          failNext = false;
          return new Response("Internal Server Error", { status: 500 });
        }
      }
      return transport.handleRequest(request);
    }
    if (method !== "initialize") {
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
    server.registerTool("slow", { description: "Slow" }, async () => {
      await slowGate;
      return { content: [{ type: "text", text: "slow done" }] };
    });
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
    throwNextCall(): void {
      throwNext = true;
    },
    staleOnEveryCall(): void {
      staleOnCall = true;
    },
    releaseSlow(): void {
      release();
      slowGate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    restore(): void {
      release();
      globalThis.fetch = original;
    },
  };
}
