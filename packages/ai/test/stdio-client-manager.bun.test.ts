import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import FakeTimers from "@sinonjs/fake-timers";
import { StdioClientManager } from "../src/mcp/stdio-client-manager.ts";

// Mock MCP SDK dynamic imports before any import that triggers them.
const mockConnect = mock().mockResolvedValue(undefined);
const mockClose = mock().mockResolvedValue(undefined);
const mockListTools = mock().mockResolvedValue({
  tools: [
    {
      name: "test-tool",
      description: "A test tool",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    },
  ],
});
const mockCallTool = mock().mockResolvedValue({
  content: [{ type: "text", text: "result" }],
});

let capturedOnclose: (() => void) | undefined;
let capturedOnerror: ((error: Error) => void) | undefined;
let capturedListChangedConfig: Record<string, unknown> | undefined;

class MockTransportImpl {
  stderr = { on: mock() };
  close = mock().mockResolvedValue(undefined);

  set onclose(fn: (() => void) | undefined) {
    capturedOnclose = fn;
  }
  get onclose() {
    return capturedOnclose;
  }
  set onerror(fn: ((error: Error) => void) | undefined) {
    capturedOnerror = fn;
  }
  get onerror() {
    return capturedOnerror;
  }
}

const MockTransport = mock().mockImplementation(function () {
  return new MockTransportImpl();
});

const MockClient = mock().mockImplementation(function (
  _info: unknown,
  options?: Record<string, unknown>,
) {
  capturedListChangedConfig = options?.["listChanged"] as
    | Record<string, unknown>
    | undefined;
  return {
    connect: mockConnect,
    close: mockClose,
    listTools: mockListTools,
    callTool: mockCallTool,
  };
});

mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: MockClient,
}));

mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: MockTransport,
}));

function createLogger() {
  return {
    info: mock(),
    warn: mock(),
    error: mock(),
    debug: mock(),
  };
}

function createManager(
  overrides: Partial<ConstructorParameters<typeof StdioClientManager>[0]> = {},
) {
  const logger = createLogger();
  const onEvent = mock();
  const onToolsUpdated = mock();

  const manager = new StdioClientManager(
    {
      serverId: "test-server",
      command: "node",
      args: ["server.js"],
      maxRestarts: 3,
      restartDelayMs: 100,
      restartBackoffMultiplier: 2,
      ...overrides,
    },
    logger,
    onEvent,
    onToolsUpdated,
  );

  return { manager, logger, onEvent, onToolsUpdated };
}

let clock: ReturnType<typeof FakeTimers.install> | undefined;

describe("StdioClientManager", () => {
  beforeEach(() => {
    clock = FakeTimers.install({
      shouldAdvanceTime: false,
      toFake: ["setTimeout", "setInterval", "Date", "setImmediate"],
    });
    mock.restore();
    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({
      tools: [
        {
          name: "test-tool",
          description: "A test tool",
          inputSchema: {
            type: "object",
            properties: { q: { type: "string" } },
          },
        },
      ],
    });
    mockCallTool.mockResolvedValue({
      content: [{ type: "text", text: "result" }],
    });
    capturedOnclose = undefined;
    capturedOnerror = undefined;
    capturedListChangedConfig = undefined;
  });

  afterEach(() => {
    clock?.uninstall();
    clock = undefined;
  });

  /**
   * @case Start creates transport and client, connects, and lists tools
   * @preconditions Manager created with valid options
   * @expectedResult SDK Client.connect and Client.listTools called; manager is running with one tool
   */
  test("start creates transport+client, connects, and lists tools", async () => {
    const { manager, onEvent, onToolsUpdated } = createManager();
    await manager.start();

    expect(MockTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "node",
        args: ["server.js"],
        stderr: "pipe",
      }),
    );
    expect(MockClient).toHaveBeenCalledWith(
      { name: "routecraft-mcp-client", version: "1.0.0" },
      expect.objectContaining({ capabilities: {} }),
    );
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockListTools).toHaveBeenCalledTimes(1);
    expect(manager.isRunning()).toBe(true);
    expect(manager.getTools()).toHaveLength(1);
    expect(manager.getTools()[0].name).toBe("test-tool");

    expect(onToolsUpdated).toHaveBeenCalledWith("test-server", [
      expect.objectContaining({ name: "test-tool" }),
    ]);
    expect(onEvent).toHaveBeenCalledWith(
      "plugin:mcp:client:test-server:started",
      expect.objectContaining({ serverId: "test-server", toolCount: 1 }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      "plugin:mcp:client:test-server:tools:listed",
      expect.objectContaining({ serverId: "test-server", toolCount: 1 }),
    );

    await manager.stop();
  });

  /**
   * @case Stop gracefully closes client and transport
   * @preconditions Manager started
   * @expectedResult client.close() called, isRunning false, stopped event emitted
   */
  test("stop gracefully closes client and transport", async () => {
    const { manager, onEvent } = createManager();
    await manager.start();
    await manager.stop();

    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(manager.isRunning()).toBe(false);
    expect(onEvent).toHaveBeenCalledWith(
      "plugin:mcp:client:test-server:stopped",
      expect.objectContaining({ serverId: "test-server", reason: "graceful" }),
    );
  });

  /**
   * @case Auto-restart on unexpected disconnect
   * @preconditions Manager started, then transport.onclose fires
   * @expectedResult Restart scheduled with delay, then reconnects; restarted event emitted
   */
  test("auto-restart on unexpected disconnect", async () => {
    const { manager, onEvent } = createManager();
    await manager.start();

    capturedOnclose?.();

    expect(manager.isRunning()).toBe(false);
    expect(onEvent).toHaveBeenCalledWith(
      "plugin:mcp:client:test-server:stopped",
      expect.objectContaining({ reason: "unexpected" }),
    );

    await clock!.tickAsync(100);

    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(manager.isRunning()).toBe(true);
    expect(onEvent).toHaveBeenCalledWith(
      "plugin:mcp:client:test-server:restarted",
      expect.objectContaining({ serverId: "test-server", restartCount: 1 }),
    );

    await manager.stop();
  });

  /**
   * @case Exponential backoff on successive restarts
   * @preconditions Manager restarts multiple times; connect fails on restarts 2 and 3
   * @expectedResult Delays increase: 100ms, 200ms, 400ms before successful reconnect
   */
  test("exponential backoff on successive restarts", async () => {
    let startCount = 0;
    mockConnect.mockImplementation(() => {
      startCount++;
      if (startCount > 1 && startCount <= 3) {
        return Promise.reject(new Error("connection refused"));
      }
      return Promise.resolve();
    });

    const { manager, onEvent } = createManager();
    await manager.start();

    capturedOnclose?.();

    await clock!.tickAsync(100);
    expect(onEvent).toHaveBeenCalledWith(
      "plugin:mcp:client:test-server:error",
      expect.objectContaining({ serverId: "test-server" }),
    );

    await clock!.tickAsync(200);
    expect(mockConnect).toHaveBeenCalledTimes(3);

    mockConnect.mockResolvedValue(undefined);
    await clock!.tickAsync(400);
    expect(mockConnect).toHaveBeenCalledTimes(4);

    await manager.stop();
  });

  /**
   * @case Max restarts exceeded emits error and stops retrying
   * @preconditions maxRestarts set to 1; connect fails on all restart attempts
   * @expectedResult Error event emitted with Max restarts message; no further reconnect
   */
  test("max restarts exceeded emits error and stops retrying", async () => {
    mockConnect.mockImplementation(() => {
      if (mockConnect.mock.calls.length > 1) {
        return Promise.reject(new Error("fail"));
      }
      return Promise.resolve();
    });

    const { manager, onEvent } = createManager({ maxRestarts: 1 });
    await manager.start();

    capturedOnclose?.();
    await clock!.tickAsync(100);

    expect(onEvent).toHaveBeenCalledWith(
      "plugin:mcp:client:test-server:error",
      expect.objectContaining({
        serverId: "test-server",
        error: expect.objectContaining({
          message: expect.stringContaining("Max restarts"),
        }),
      }),
    );

    mockConnect.mockResolvedValue(undefined);
  });

  /**
   * @case callTool delegates to SDK client.callTool()
   * @preconditions Manager started
   * @expectedResult callTool returns result from SDK
   */
  test("callTool delegates to SDK client", async () => {
    const { manager } = createManager();
    await manager.start();

    const result = await manager.callTool("test-tool", { q: "hello" });
    expect(result).toBe("result");
    expect(mockCallTool).toHaveBeenCalledWith({
      name: "test-tool",
      arguments: { q: "hello" },
    });

    await manager.stop();
  });

  /**
   * @case callTool throws when not running
   * @preconditions Manager not started
   * @expectedResult Throws error matching /not running/
   */
  test("callTool throws when not running", async () => {
    const { manager } = createManager();
    await expect(manager.callTool("test-tool", {})).rejects.toThrow(
      /not running/,
    );
  });

  /**
   * @case Stop cancels pending restart timer
   * @preconditions Manager disconnected, restart pending in queue
   * @expectedResult After stop, no additional connect calls fired after delay
   */
  test("stop cancels pending restart timer", async () => {
    const { manager } = createManager();
    await manager.start();

    const connectCallsBefore = mockConnect.mock.calls.length;

    capturedOnclose?.();
    await manager.stop();

    await clock!.tickAsync(200);

    expect(mockConnect.mock.calls.length).toBe(connectCallsBefore);
  });

  /**
   * @case transport.onerror emits error event
   * @preconditions Manager started, transport error occurs
   * @expectedResult Error event emitted with the transport error
   */
  test("transport.onerror emits error event", async () => {
    const { manager, onEvent } = createManager();
    await manager.start();

    const err = new Error("pipe broken");
    capturedOnerror?.(err);

    expect(onEvent).toHaveBeenCalledWith(
      "plugin:mcp:client:test-server:error",
      expect.objectContaining({ serverId: "test-server", error: err }),
    );

    await manager.stop();
  });

  /**
   * @case start with env and cwd passes them to transport
   * @preconditions Manager created with env and cwd overrides
   * @expectedResult StdioClientTransport receives env and cwd
   */
  test("start passes env and cwd to transport", async () => {
    const { manager } = createManager({
      env: { MY_VAR: "value" },
      cwd: "/tmp",
    });
    await manager.start();

    expect(MockTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { MY_VAR: "value" },
        cwd: "/tmp",
      }),
    );

    await manager.stop();
  });

  /**
   * @case listChanged.tools.onChanged is configured on client creation
   * @preconditions Manager started
   * @expectedResult Client constructed with listChanged config present
   */
  test("configures listChanged.tools.onChanged on client", async () => {
    const { manager } = createManager();
    await manager.start();

    expect(capturedListChangedConfig).toBeDefined();
    expect(
      (capturedListChangedConfig as Record<string, unknown>)?.["tools"],
    ).toBeDefined();

    await manager.stop();
  });

  /**
   * @case Idempotent start (calling start twice does nothing)
   * @preconditions Manager already running
   * @expectedResult Second start is a no-op; connect called exactly once
   */
  test("start is idempotent when already running", async () => {
    const { manager } = createManager();
    await manager.start();
    await manager.start();

    expect(mockConnect).toHaveBeenCalledTimes(1);

    await manager.stop();
  });
});
