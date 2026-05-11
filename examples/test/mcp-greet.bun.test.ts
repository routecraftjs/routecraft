import { describe, it, expect, afterEach } from "bun:test";
import type { Mock } from "bun:test";
import { mcp } from "@routecraft/ai";
import {
  mockAdapter,
  testContext,
  type TestContext,
} from "@routecraft/testing";

// env.ts validates with Zod at module load; provide placeholders.
process.env["JWT_SECRET"] ??= "test-jwt-secret";
process.env["MAIL_USER"] ??= "test@example.test";
process.env["MAIL_APP_PASSWORD"] ??= "test-pw";
process.env["GEMINI_API_KEY"] ??= "test-gemini";
process.env["OPENROUTER_API_KEY"] ??= "test-openrouter";

const route = (await import("../src/mcp-greet")).default;

describe("mcp-greet", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case mcp source yields a payload; the route greets by user and logs the result
   * @preconditions mockAdapter(mcp, { source: [...] }) stands in for the MCP server's dispatch
   * @expectedResult The tap(log()) logs an object whose body.user matches; transform output reaches noop
   */
  it("greets a user from an mcp payload", async () => {
    const mcpMock = mockAdapter(mcp, {
      source: [{ user: "Ada" }],
    });

    t = await testContext().override(mcpMock).routes(route).build();
    await t.test();

    expect(mcpMock.calls.source).toHaveLength(1);
    expect(mcpMock.calls.source[0].yielded).toBe(1);

    // The tap(log()) in the route logs the payload before transform.
    const infoSpy = t.logger.info as Mock<(...args: unknown[]) => void>;
    const tapLog = infoSpy.mock.calls.find((c) => c[1] === "LogAdapter output");
    expect(tapLog).toBeDefined();
    expect((tapLog![0] as { body: { user: string } }).body.user).toBe("Ada");
  });
});
