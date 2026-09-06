/**
 * A real instance with the ACP mount on it, and a real client on the other
 * end of a real socket.
 *
 * The transport is the load-bearing part of this block, so the tests drive
 * it through the SDK's own HTTP client rather than calling handlers
 * directly. Nothing here stubs the protocol.
 */

import {
  client,
  type ClientContext,
  type InitializeResponse,
} from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import {
  MemorySuspensionStore,
  type AnyRouteBuilder,
  type CraftPlugin,
  type Principal,
} from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import { acpPlugin, agentPlugin, llmPlugin } from "../../src/index.ts";
import type { AcpPluginOptions } from "../../src/acp/types.ts";
import type { AgentRegisteredOptions } from "../../src/agent/types.ts";
import {
  MemorySessionStore,
  type SessionStore,
} from "../../src/agent/session/index.ts";

/** An instance serving ACP, and where to reach it. */
export interface AcpHarness {
  readonly t: TestContext;
  readonly url: string;
  /**
   * Open a client connection, initialize it, and run `op`.
   *
   * The initialize response is handed to `op` rather than made again,
   * because the protocol allows exactly one per connection.
   */
  connect<T>(
    op: (agent: ClientContext, initialized: InitializeResponse) => Promise<T>,
    options?: { token?: string; capabilities?: ClientOptions },
  ): Promise<T>;
  /** Every `session/update` the client saw, in arrival order, with its time. */
  readonly seen: Array<{ at: number; sessionId: string; update: unknown }>;
}

/** What the test client says it can do. */
export interface ClientOptions {
  readonly fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  readonly terminal?: boolean;
}

export interface AcpHarnessOptions {
  readonly agents: Record<string, AgentRegisteredOptions>;
  readonly acp?: AcpPluginOptions;
  /** A bearer validator on the server, for the walled cases. */
  readonly validator?: (token: string) => Principal;
  /** Extra plugins, applied before the ACP mount. */
  readonly plugins?: CraftPlugin[];
  /** The session store, for a test that needs one that fails or stalls. */
  readonly sessionStore?: SessionStore;
  /** Routes the app brings, beside the ones the mount builds. */
  readonly routes?: AnyRouteBuilder[];
  /** Handlers the client answers agent-side calls with. */
  readonly handlers?: (app: ReturnType<typeof client>) => void;
}

/** Boot an instance with the ACP mount and return a client for it. */
export async function acpHarness(
  options: AcpHarnessOptions,
): Promise<AcpHarness> {
  let port = 0;
  const suspension = new MemorySuspensionStore();
  const t = await testContext()
    .on("server:listening", ({ details }) => {
      port = details.port;
    })
    .with({
      servers: {
        default: {
          host: "127.0.0.1",
          port: 0,
          ...(options.validator !== undefined
            ? { auth: { validator: options.validator } }
            : {}),
        },
      },
      suspension: { store: suspension },
      sessions: { store: options.sessionStore ?? new MemorySessionStore() },
      shutdown: { timeout: 500 },
      plugins: [
        llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        agentPlugin({ agents: options.agents }),
        ...(options.plugins ?? []),
        acpPlugin(options.acp ?? {}),
      ],
    })
    .routes(options.routes ?? [])
    .build();
  await t.startAndWaitReady();

  const seen: Array<{ at: number; sessionId: string; update: unknown }> = [];
  const url = `http://127.0.0.1:${port}${options.acp?.path ?? "/acp"}`;

  return {
    t,
    url,
    seen,
    async connect(op, connectOptions) {
      const app = client({ name: "test-editor" }).onNotification(
        "session/update",
        ({ params }) => {
          seen.push({
            at: Date.now(),
            sessionId: params.sessionId,
            update: params.update,
          });
        },
      );
      options.handlers?.(app);
      const stream = createHttpStream(url, {
        headers:
          connectOptions?.token === undefined
            ? {}
            : { Authorization: `Bearer ${connectOptions.token}` },
      });
      return app.connectWith(stream, async (agent) => {
        const initialized: InitializeResponse = await agent.request(
          "initialize",
          {
            protocolVersion: 1,
            clientCapabilities: {
              ...(connectOptions?.capabilities?.fs !== undefined
                ? { fs: connectOptions.capabilities.fs }
                : {}),
              ...(connectOptions?.capabilities?.terminal !== undefined
                ? { terminal: connectOptions.capabilities.terminal }
                : {}),
            },
            clientInfo: { name: "test-editor", version: "0.0.0" },
          },
        );
        return op(agent, initialized);
      });
    },
  };
}
