import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import { craft, simple } from "@routecraft/routecraft";
import {
  agentBrowser,
  type AgentBrowserResult,
  sanitizeSessionId,
} from "@routecraft/browser";

type CommandArg = { id: string; action: string; [key: string]: unknown };
type CommandResult = Promise<{
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}>;

const { executeCommandMock, BrowserManagerMock } = vi.hoisted(() => ({
  executeCommandMock:
    vi.fn<(cmd: CommandArg, manager: unknown) => CommandResult>(),
  BrowserManagerMock: vi.fn(function BrowserManager(this: unknown) {
    return {};
  }),
}));

vi.mock("agent-browser/dist/actions.js", () => ({
  executeCommand: (cmd: CommandArg, manager: unknown) =>
    executeCommandMock(cmd, manager),
}));

vi.mock("agent-browser/dist/browser.js", () => ({
  BrowserManager: BrowserManagerMock,
}));

describe("Browser Adapter", () => {
  let t: TestContext;

  beforeEach(() => {
    executeCommandMock.mockClear();
    executeCommandMock.mockImplementation(async (cmd: CommandArg) => {
      if (cmd.action === "launch")
        return { success: true, data: { launched: true } };
      if (cmd.action === "navigate")
        return {
          success: true,
          data: { url: cmd["url"] ?? "", title: "" },
        };
      if (cmd.action === "snapshot")
        return { success: true, data: { snapshot: "mock stdout" } };
      if (cmd.action === "close")
        return { success: true, data: { closed: true } };
      return { success: true, data: {} };
    });
  });

  afterEach(async () => {
    if (t) await t.stop();
    vi.restoreAllMocks();
  });

  describe("sanitizeSessionId", () => {
    /**
     * @case Session id with only allowed chars is unchanged
     * @preconditions Input contains alphanumeric, hyphen, underscore only
     * @expectedResult Same string is returned
     */
    test("keeps alphanumeric, hyphen, underscore", () => {
      expect(sanitizeSessionId("abc-123_xyz")).toBe("abc-123_xyz");
    });

    /**
     * @case Invalid session id chars are replaced with underscore
     * @preconditions Input contains dots or other disallowed chars
     * @expectedResult Invalid chars replaced by underscore
     */
    test("replaces invalid chars with underscore", () => {
      expect(sanitizeSessionId("a.b.c")).toBe("a_b_c");
      expect(sanitizeSessionId("id-with-dots.and.slashes")).toBe(
        "id-with-dots_and_slashes",
      );
    });

    /**
     * @case UUID-style exchange id is valid session name
     * @preconditions Input is UUID format (hyphens, hex)
     * @expectedResult Same string is returned
     */
    test("handles UUID-like input", () => {
      const id = "550e8400-e29b-41d4-a716-446655440000";
      expect(sanitizeSessionId(id)).toBe(id);
    });
  });

  describe("argument building and session", () => {
    /**
     * @case Browser adapter calls executeCommand with snapshot and session via manager
     * @preconditions Route with agentBrowser("snapshot") enrich step
     * @expectedResult executeCommand called with launch then snapshot (session isolation)
     */
    test("executeCommand called with snapshot after launch for session", async () => {
      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("browser-session-test")
            .from(simple("trigger"))
            .enrich(agentBrowser("snapshot"))
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(executeCommandMock).toHaveBeenCalled();
      const actions = executeCommandMock.mock.calls.map((c) => c[0].action);
      expect(actions).toContain("launch");
      expect(actions).toContain("snapshot");
    });

    /**
     * @case open command results in navigate with url
     * @preconditions agentBrowser("open", { url }) in route
     * @expectedResult executeCommand called with navigate action and url
     */
    test("agentBrowser(open, { url }) calls navigate with url", async () => {
      const s = spy();
      const url = "https://example.com";

      t = await testContext()
        .routes(
          craft()
            .id("browser-open-test")
            .from(simple("trigger"))
            .enrich(agentBrowser("open", { url }))
            .to(s),
        )
        .build();

      await t.ctx.start();

      const navigateCall = executeCommandMock.mock.calls.find(
        (c) => c[0].action === "navigate",
      );
      expect(navigateCall).toBeDefined();
      expect(navigateCall![0]["url"]).toBe(url);
    });

    /**
     * @case open url resolved from exchange body via function option
     * @preconditions agentBrowser("open", { url: (e) => e.body.link }) with body containing link
     * @expectedResult executeCommand navigate uses resolved url from exchange
     */
    test("dynamic url from exchange body", async () => {
      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("browser-dynamic-url")
            .from(simple({ link: "https://dynamic.example.com" }))
            .enrich(agentBrowser("open", { url: (e) => e.body.link }))
            .to(s),
        )
        .build();

      await t.ctx.start();

      const navigateCall = executeCommandMock.mock.calls.find(
        (c) => c[0].action === "navigate",
      );
      expect(navigateCall).toBeDefined();
      expect(navigateCall![0]["url"]).toBe("https://dynamic.example.com");
    });

    /**
     * @case close command invokes close action
     * @preconditions agentBrowser("close") in route
     * @expectedResult executeCommand called with close action
     */
    test("agentBrowser(close) passes close command", async () => {
      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("browser-close-test")
            .from(simple("trigger"))
            .to(agentBrowser("close"))
            .to(s),
        )
        .build();

      await t.ctx.start();

      const closeCall = executeCommandMock.mock.calls.find(
        (c) => c[0].action === "close",
      );
      expect(closeCall).toBeDefined();
    });
  });

  describe("option resolution", () => {
    /**
     * @case enrich with agentBrowser returns result with stdout and exitCode
     * @preconditions Route with agentBrowser("snapshot") enrich, mock returns snapshot data
     * @expectedResult Enriched body has stdout and exitCode from AgentBrowserResult
     */
    test("returns AgentBrowserResult with stdout and exitCode", async () => {
      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("browser-result-test")
            .from(simple("trigger"))
            .enrich(agentBrowser("snapshot"))
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(s.received).toHaveLength(1);
      const enrichedBody = s.received[0].body as AgentBrowserResult & {
        stdout: string;
        exitCode: number;
      };
      expect(enrichedBody.stdout).toBe("mock stdout");
      expect(enrichedBody.exitCode).toBe(0);
    });

    /**
     * @case json option sets result.parsed to response data
     * @preconditions agentBrowser("snapshot", { json: true })
     * @expectedResult result.parsed is the command response data
     */
    test("json option parses stdout into result.parsed", async () => {
      executeCommandMock.mockImplementation(async (cmd: CommandArg) => {
        if (cmd.action === "launch")
          return { success: true, data: { launched: true } };
        if (cmd.action === "snapshot")
          return {
            success: true,
            data: { snapshot: "tree", refs: { e1: { role: "button" } } },
          };
        return { success: true, data: {} };
      });
      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("browser-json-test")
            .from(simple("trigger"))
            .enrich(agentBrowser("snapshot", { json: true }))
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(s.received).toHaveLength(1);
      const result = s.received[0].body as AgentBrowserResult;
      expect(result.parsed).toEqual({
        snapshot: "tree",
        refs: { e1: { role: "button" } },
      });
    });
  });
});
