import { rcError } from "../../../error";
import { startNodeServer, type NodeServerHandle } from "./node";

/**
 * Common handle returned by {@link startServer}. Implementations on Bun and
 * Node both satisfy this; callers do not need to know which runtime is
 * powering the listener.
 */
export interface HttpServerHandle {
  readonly port: number;
  close(): Promise<void>;
}

export interface StartServerOptions {
  port: number;
  host: string;
  fetch: (req: Request) => Promise<Response>;
}

interface BunLike {
  serve(opts: {
    port: number;
    hostname: string;
    fetch: (req: Request) => Promise<Response> | Response;
  }): {
    readonly port: number;
    stop(closeActiveConnections?: boolean): Promise<void> | void;
  };
}

function getBun(): BunLike | undefined {
  const candidate = (globalThis as { Bun?: BunLike }).Bun;
  if (candidate && typeof candidate.serve === "function") {
    return candidate;
  }
  return undefined;
}

/**
 * Bind a Web-standard fetch handler to a port. Picks the Bun-native path
 * when `globalThis.Bun.serve` exists, else falls back to the `node:http`
 * shim. Throws `RC5019` if the port cannot be bound.
 */
export async function startServer(
  opts: StartServerOptions,
): Promise<HttpServerHandle> {
  const bun = getBun();
  if (bun) {
    try {
      const server = bun.serve({
        port: opts.port,
        hostname: opts.host,
        fetch: opts.fetch,
      });
      return {
        port: server.port,
        close: async () => {
          await server.stop(true);
        },
      };
    } catch (err) {
      throw rcError("RC5019", err, {
        message: `HTTP server bind failed on ${opts.host}:${opts.port}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const handle: NodeServerHandle = await startNodeServer(opts);
  return handle;
}
