import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import { rcError } from "../../../error";

export interface NodeServerHandle {
  /** Resolved port (useful when `port: 0` is passed to let the OS choose). */
  readonly port: number;
  /** Stop accepting new connections and wait for in-flight requests to complete. */
  close(): Promise<void>;
}

export interface NodeServerOptions {
  port: number;
  host: string;
  /** Web-standard fetch handler. */
  fetch: (req: Request) => Promise<Response>;
}

/**
 * Bridge Node's `http.createServer` into a Web-standard `(Request) => Response`
 * handler. Used on Node 22+ where `Bun.serve` is not available.
 *
 * The shim covers the surface our dispatcher needs:
 *   - Convert IncomingMessage to a Web Request (headers, method, body stream).
 *   - Convert the Response back (status, headers, body stream).
 *   - Surface bind failures as `RC5019`.
 *
 * Anything outside that scope (HTTP/2, TLS, request timeouts, raw socket
 * access) is deliberately not bridged.
 */
export function startNodeServer(
  opts: NodeServerOptions,
): Promise<NodeServerHandle> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      void handle(opts.fetch, req, res, opts.host);
    });

    const onError = (err: Error): void => {
      reject(
        rcError("RC5019", err, {
          message: `HTTP server bind failed on ${opts.host}:${opts.port}: ${err.message}`,
        }),
      );
    };
    server.once("error", onError);
    server.listen(opts.port, opts.host, () => {
      server.off("error", onError);
      // Re-attach a softer error handler so runtime errors after bind are
      // logged but do not crash the process.
      server.on("error", () => {
        // Intentionally swallowed; per-request errors land on the request
        // path which converts them to 5xx responses.
      });

      const address = server.address() as AddressInfo | null;
      const resolvedPort = address?.port ?? opts.port;
      resolve({
        port: resolvedPort,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

async function handle(
  fetchHandler: (req: Request) => Promise<Response>,
  nReq: IncomingMessage,
  nRes: ServerResponse,
  fallbackHost: string,
): Promise<void> {
  try {
    const webReq = toWebRequest(nReq, fallbackHost);
    const webRes = await fetchHandler(webReq);
    await writeNodeResponse(nRes, webRes);
  } catch {
    // The dispatcher is responsible for normalising everything to a Response;
    // anything that escapes is a bug we still need to answer for. Emit a 500
    // with a tiny body so the client always gets a closed response.
    if (!nRes.headersSent) {
      nRes.statusCode = 500;
      nRes.setHeader("content-type", "text/plain; charset=utf-8");
    }
    try {
      nRes.end("Internal Server Error");
    } catch {
      nRes.destroy();
    }
  }
}

function toWebRequest(req: IncomingMessage, fallbackHost: string): Request {
  const host = req.headers.host ?? fallbackHost;
  // `req.url` is always a path-and-query when received by an HTTP server.
  const url = new URL(req.url ?? "/", `http://${host}`);

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(name, v);
    } else {
      headers.set(name, value);
    }
  }

  const method = (req.method ?? "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const init: RequestInit = { method, headers };
  if (hasBody) {
    // Readable.toWeb returns ReadableStream<any>; the Request constructor
    // wants ReadableStream<Uint8Array>. Cast through unknown so TS does not
    // complain about variance on the chunk type.
    init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    // Node's fetch Request requires `duplex: "half"` when constructed with a
    // stream body. The field is not yet on the standard RequestInit so we
    // attach it via a cast.
    (init as RequestInit & { duplex: "half" }).duplex = "half";
  }
  return new Request(url.toString(), init);
}

async function writeNodeResponse(
  nRes: ServerResponse,
  webRes: Response,
): Promise<void> {
  nRes.statusCode = webRes.status;
  if (webRes.statusText) nRes.statusMessage = webRes.statusText;
  webRes.headers.forEach((value, key) => {
    // Set-Cookie is handled separately below; forEach joins multiple values
    // with ", " which is wrong for cookie headers (cookie values can contain
    // ", " themselves and the Vary semantics differ).
    if (key.toLowerCase() === "set-cookie") return;
    nRes.setHeader(key, value);
  });
  // getSetCookie() returns each cookie as a separate string, preserving the
  // boundary between distinct Set-Cookie fields (Node 20+, Bun 1+).
  const cookies =
    typeof webRes.headers.getSetCookie === "function"
      ? webRes.headers.getSetCookie()
      : [];
  if (cookies.length > 0) {
    nRes.setHeader("Set-Cookie", cookies);
  }

  if (!webRes.body) {
    nRes.end();
    return;
  }

  const reader = webRes.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        if (!nRes.write(value)) {
          await new Promise<void>((resolve) => nRes.once("drain", resolve));
        }
      }
    }
  } finally {
    nRes.end();
  }
}
