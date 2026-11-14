import "./env-placeholders";
import { describe, it, expect, afterEach } from "bun:test";
import type { Mock } from "bun:test";
import { mcp } from "@routecraft/ai";
import {
  mockAdapter,
  testContext,
  type TestContext,
} from "@routecraft/testing";

const route = (await import("../src/mcp-greet")).default;

describe("mcp-greet", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case mcp source yields a payload; the route greets by user and logs the greeting
   * @preconditions mockAdapter(mcp, { source: [...] }) stands in for the MCP server's dispatch
   * @expectedResult The .log() after the transform logs "Hello, Ada!"
   */
  it("greets a user from an mcp payload", async () => {
    const mcpMock = mockAdapter(mcp, {
      source: [{ user: "Ada" }],
    });

    t = await testContext().override(mcpMock).routes(route).build();
    await t.test();

    expect(mcpMock.calls.source).toHaveLength(1);
    expect(mcpMock.calls.source[0].yielded).toBe(1);

    const infoSpy = t.logger.info as Mock<(...args: unknown[]) => void>;
    const greeting = infoSpy.mock.calls.find(
      (call: unknown[]) => call[1] === "Greeting built",
    );
    expect(greeting).toBeDefined();
    expect((greeting![0] as { greeting: string }).greeting).toBe("Hello, Ada!");
  });
});
