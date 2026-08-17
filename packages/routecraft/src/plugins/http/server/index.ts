import { rcError } from "../../../error";
import { startNodeServer, type NodeServerHandle } from "./node";

/**
 * Common handle returned by {@link startServer}. Implementations on Bun and
 * Node both satisfy this; callers do not need to know which runtime is
 * powering the listener.
 */
export interface HttpServerHandle {
  readonly port: number;
  gracefulClose(): Promise<void>;
  forceClose(): Promise<void>;
}

/**
 * Per-request capabilities the runtime listener hands the dispatcher.
 * `exemptFromIdleTimeout` lifts the listener's idle timeout for one request
 * so a long-lived stream (MCP streamable HTTP, SSE) can stay quiet
 * indefinitely while ordinary connections keep being reaped. A no-op on
 * Node, whose timeouts do not govern response streaming.
 */
export interface HttpServerRuntime {
  exemptFromIdleTimeout(req: Request): void;
}

export interface StartServerOptions {
  port: number;
  host: string;
  fetch: (req: Request, runtime: HttpServerRuntime) => Promise<Response>;
}

interface BunServeHandle {
  readonly port: number;
  stop(closeActiveConnections?: boolean): Promise<void> | void;
  /** Per-request idle timeout override; 0 disables it for that request. */
  timeout?(req: Request, seconds: number): void;
}

interface BunLike {
  serve(opts: {
    port: number;
    hostname: string;
    idleTimeout: number;
    fetch: (
      req: Request,
      server: BunServeHandle,
    ) => Promise<Response> | Response;
  }): BunServeHandle;
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
        // Ordinary connections are reaped after 255s idle (Bun's maximum;
        // 0 would disable the reaper entirely, letting parked sockets
        // accumulate to the fd limit and holding graceful close open).
        // Long-lived quiet streams survive via the per-request exemption
        // below, not by widening this default.
        idleTimeout: 255,
        fetch: (req, bunServer) =>
          opts.fetch(req, {
            // Lift the idle timeout for one request only: mounts that
            // declare long-lived streams (MCP, SSE) opt their requests out
            // while every other connection keeps being reaped.
            exemptFromIdleTimeout: (r) => bunServer.timeout?.(r, 0),
          }),
      });
      return {
        port: server.port,
        gracefulClose: async () => {
          await server.stop(false);
        },
        forceClose: async () => {
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
