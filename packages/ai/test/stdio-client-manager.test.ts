import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { StdioClientManager } from "../src/mcp/stdio-client-manager.ts";

// Mock the MCP SDK dynamic imports
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockListTools = vi.fn().mockResolvedValue({
  tools: [
    {
      name: "test-tool",
      description: "A test tool",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    },
  ],
});
const mockCallTool = vi.fn().mockResolvedValue({
  content: [{ type: "text", text: "result" }],
});

let capturedOnclose: (() => void) | undefined;
let capturedOnerror: ((error: Error) => void) | undefined;
let capturedListChangedConfig: Record<string, unknown> | undefined;

class MockTransportImpl {
  stderr = { on: vi.fn() };
  close = vi.fn().mockResolvedValue(undefined);

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

const MockTransport = vi.fn().mockImplementation(function () {
  return new MockTransportImpl();
});

const MockClient = vi.fn().mockImplementation(function (
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

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: MockClient,
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: MockTransport,
}));

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createManager(
  overrides: Partial<ConstructorParameters<typeof StdioClientManager>[0]> = {},
) {
  const logger = createLogger();
  const onEvent = vi.fn();
  const onToolsUpdated = vi.fn();

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

describe("StdioClientManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    capturedOnclose = undefined;
    capturedOnerror = undefined;
    capturedListChangedConfig = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * @case Start creates transport and client, connects, and lists tools
   * @preconditions Manager created with valid options
   * @expectedResult SDK Client.connect and Client.listTools called
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
   * @expectedResult client.close() and transport.close() called, isRunning false
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
   * @expectedResult Restart scheduled with delay, then reconnects
   */
  test("auto-restart on unexpected disconnect", async () => {
    const { manager, onEvent } = createManager();
    await manager.start();

    // Simulate unexpected disconnect
    capturedOnclose?.();

    expect(manager.isRunning()).toBe(false);
    expect(onEvent).toHaveBeenCalledWith(
      "plugin:mcp:client:test-server:stopped",
      expect.objectContaining({ reason: "unexpected" }),
    );

    // Fast-forward past the restart delay (100ms)
    await vi.advanceTimersByTimeAsync(100);

    // Should have restarted
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
   * @preconditions Manager restarts multiple times
   * @expectedResult Delays increase: 100, 200, 400ms
   */
  test("exponential backoff on successive restarts", async () => {
    // Make start fail after first success to trigger repeated restarts
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

    // Simulate disconnect
    capturedOnclose?.();

    // First restart at 100ms - will fail
    await vi.advanceTimersByTimeAsync(100);
    expect(onEvent).toHaveBeenCalledWith(
      "plugin:mcp:client:test-server:error",
      expect.objectContaining({ serverId: "test-server" }),
    );

    // Second restart at 200ms (100 * 2^1) - will fail
    await vi.advanceTimersByTimeAsync(200);
    expect(mockConnect).toHaveBeenCalledTimes(3);

    // Third restart at 400ms (100 * 2^2) - will succeed
    mockConnect.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(400);
    expect(mockConnect).toHaveBeenCalledTimes(4);

    await manager.stop();
    mockConnect.mockResolvedValue(undefined);
  });

  /**
   * @case Max restarts exceeded emits error and stops retrying
   * @preconditions maxRestarts set to 1, two disconnects occur
   * @expectedResult Error event emitted, no more restart attempts
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

    // First disconnect
    capturedOnclose?.();
    await vi.advanceTimersByTimeAsync(100);

    // Restart failed, handleDisconnect called again with restartCount=1 >= maxRestarts=1
    // Should get max restarts error
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
   * @expectedResult Throws error about not running
   */
  test("callTool throws when not running", async () => {
    const { manager } = createManager();
    await expect(manager.callTool("test-tool", {})).rejects.toThrow(
      /not running/,
    );
  });

  /**
   * @case Stop cancels pending restart timer
   * @preconditions Manager disconnected, restart pending
   * @expectedResult After stop, no restart occurs
   */
  test("stop cancels pending restart timer", async () => {
    const { manager } = createManager();
    await manager.start();

    const connectCallsBefore = mockConnect.mock.calls.length;

    // Trigger disconnect (schedules restart)
    capturedOnclose?.();

    // Stop before restart fires
    await manager.stop();

    // Advance past restart delay
    await vi.advanceTimersByTimeAsync(200);

    // No additional connect calls
    expect(mockConnect.mock.calls.length).toBe(connectCallsBefore);
  });

  /**
   * @case transport.onerror emits error event
   * @preconditions Manager started, transport error occurs
   * @expectedResult Error event emitted
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
   * @preconditions Manager created with env and cwd
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
   * @case listChanged.tools.onChanged is configured
   * @preconditions Manager started
   * @expectedResult Client created with listChanged config
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
   * @expectedResult Second start is no-op
   */
  test("start is idempotent when already running", async () => {
    const { manager } = createManager();
    await manager.start();
    await manager.start(); // should be no-op

    expect(mockConnect).toHaveBeenCalledTimes(1);

    await manager.stop();
  });
});
