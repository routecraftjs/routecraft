/**
 * Wire coverage for MCP Apps views attached with `mcp({ ui })` (#857).
 *
 * The witness is the installed `@modelcontextprotocol/client` over a real
 * socket, so the tool's `_meta.ui.resourceUri`, the `ui://` resource, and the
 * structured result are checked as a host would read them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  craft,
  type AnyRouteBuilder,
  type StoreRegistry,
} from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { McpServer } from "../src/mcp/server.ts";
import { MCP_PLUGIN_REGISTERED } from "../src/mcp/types.ts";
import type { McpPluginOptions, McpServerOptions } from "../src/mcp/types.ts";
import { fromFile, mcp, mcpPlugin } from "../src/index.ts";

const MCP_STORE_KEY = MCP_PLUGIN_REGISTERED as keyof StoreRegistry;

const MAIL_CARD =
  "<!doctype html><html><body><div id=card></div></body></html>";

const SendMailResult = z.object({ to: z.string(), subject: z.string() });

/** A tool with a view: the shape the eywa send-mail tool takes. */
function sendMail(options: McpServerOptions = {}): AnyRouteBuilder {
  return craft()
    .id("send-mail")
    .title("Send mail")
    .description("Hold an email for review")
    .output({ body: SendMailResult })
    .from<{ to: string; subject: string }>(mcp(options))
    .transform((body) => ({
      to: body.to,
      subject: body.subject,
    })) as AnyRouteBuilder;
}

/** A tool without a view, which must be left exactly as before. */
function listTasks(): AnyRouteBuilder {
  return craft()
    .id("list-tasks")
    .description("List open tasks")
    .from(mcp())
    .transform(() => "none") as AnyRouteBuilder;
}

describe("MCP Apps views (#857)", () => {
  let t: TestContext | undefined;
  let server: McpServer | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    if (client) await client.close();
    if (server) await server.stop();
    if (t) await t.stop();
    client = undefined;
    server = undefined;
    t = undefined;
  });

  /** Boot an HTTP MCP server on an ephemeral port and connect the SDK client. */
  async function connect(
    routes: AnyRouteBuilder[],
    options: McpPluginOptions = {},
  ): Promise<Client> {
    t = await testContext()
      .store(MCP_STORE_KEY, true)
      .with({ servers: { default: { host: "127.0.0.1", port: 0 } } })
      .routes(routes)
      .build();
    server = new McpServer(t.ctx, { transport: "http", ...options });
    await server.prepare();
    await t.startAndWaitReady();
    await server.start();

    const connected = new Client({ name: "mcp-apps-test", version: "1.0.0" });
    await connected.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.getHttpPort()}/mcp`),
      ),
    );
    client = connected;
    return connected;
  }

  /**
   * @case A tool with a view round-trips list, resource read, and call the way a host drives it
   * @preconditions send-mail route with .output() and mcp({ ui: { html, csp, prefersBorder } }) on a server named "eywa"; the real SDK client over HTTP
   * @expectedResult tools/list carries _meta.ui.resourceUri ui://eywa/send-mail; resources/list names it with the MCP App MIME type; resources/read returns the HTML with csp and prefersBorder under _meta.ui and emits plugin:mcp:ui:served once; tools/call returns structuredContent beside the text fallback
   */
  test("list, read resource, and call round-trip over HTTP", async () => {
    const csp = { resourceDomains: ["https://cdn.example.com"] };
    const connected = await connect(
      [sendMail({ ui: { html: MAIL_CARD, csp, prefersBorder: true } })],
      { name: "eywa" },
    );

    const { tools } = await connected.listTools();
    const tool = tools.find((candidate) => candidate.name === "send-mail");
    expect(tool?._meta).toEqual({
      ui: { resourceUri: "ui://eywa/send-mail" },
    });

    const { resources } = await connected.listResources();
    expect(resources).toEqual([
      {
        uri: "ui://eywa/send-mail",
        name: "send-mail",
        title: "Send mail",
        mimeType: "text/html;profile=mcp-app",
      },
    ]);

    const served: Array<Record<string, unknown>> = [];
    t!.ctx.on("plugin:mcp:ui:served", (event) => {
      served.push(event.details);
    });
    const read = await connected.readResource({ uri: "ui://eywa/send-mail" });
    expect(read.contents).toEqual([
      {
        uri: "ui://eywa/send-mail",
        mimeType: "text/html;profile=mcp-app",
        text: MAIL_CARD,
        _meta: { ui: { csp, prefersBorder: true } },
      },
    ]);
    expect(served).toEqual([{ tool: "send-mail", uri: "ui://eywa/send-mail" }]);

    const result = await connected.callTool({
      name: "send-mail",
      arguments: { to: "a@example.com", subject: "Hi" },
    });
    expect(result.structuredContent).toEqual({
      to: "a@example.com",
      subject: "Hi",
    });
    expect((result.content as Array<{ text: string }>)[0]!.text).toBe(
      JSON.stringify({ to: "a@example.com", subject: "Hi" }),
    );
  });

  /**
   * @case A tool without a view is advertised exactly as before
   * @preconditions One route with a view and one without on the same server
   * @expectedResult The plain tool carries no _meta and has no resource; the resource list holds only the view
   */
  test("a tool without ui is unchanged", async () => {
    const connected = await connect([
      sendMail({ ui: { html: MAIL_CARD } }),
      listTasks(),
    ]);

    const { tools } = await connected.listTools();
    const plain = tools.find((candidate) => candidate.name === "list-tasks");
    expect(plain).toBeDefined();
    expect(plain!._meta).toBeUndefined();

    const { resources } = await connected.listResources();
    expect(resources.map((resource) => resource.name)).toEqual(["send-mail"]);
  });

  /**
   * @case A server with no views still answers resource discovery
   * @preconditions Only a tool without ui
   * @expectedResult resources/list and resources/templates/list both answer empty rather than method-not-found
   */
  test("resource discovery answers empty with no views", async () => {
    const connected = await connect([listTasks()]);

    expect((await connected.listResources()).resources).toEqual([]);
    expect((await connected.listResourceTemplates()).resourceTemplates).toEqual(
      [],
    );
  });

  /**
   * @case A view is resolved by its loader on every read
   * @preconditions ui.html is fromFile() over a temp file that is rewritten between two reads
   * @expectedResult Each read returns the file's contents at that moment
   */
  test("fromFile() serves the view's current contents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-apps-"));
    try {
      const path = join(dir, "card.html");
      await writeFile(path, "<p>one</p>");
      const connected = await connect([
        sendMail({ ui: { html: fromFile(path) } }),
      ]);

      const first = await connected.readResource({
        uri: "ui://routecraft/send-mail",
      });
      expect((first.contents[0] as { text: string }).text).toBe("<p>one</p>");

      await writeFile(path, "<p>two</p>");
      const second = await connected.readResource({
        uri: "ui://routecraft/send-mail",
      });
      expect((second.contents[0] as { text: string }).text).toBe("<p>two</p>");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * @case A view whose loader fails answers a generic error
   * @preconditions ui.html is fromFile() over a path that does not exist
   * @expectedResult readResource rejects naming the tool without the host path; plugin:mcp:ui:failed fires once carrying the path for the operator
   */
  test("a failing loader does not leak the host path", async () => {
    const missing = join(tmpdir(), "mcp-apps-missing", "card.html");
    const connected = await connect([
      sendMail({ ui: { html: fromFile(missing) } }),
    ]);
    const failures: Array<Record<string, unknown>> = [];
    t!.ctx.on("plugin:mcp:ui:failed", (event) => {
      failures.push(event.details);
    });

    const error = await connected
      .readResource({ uri: "ui://routecraft/send-mail" })
      .then(
        () => undefined,
        (caught: unknown) => caught as Error,
      );
    expect(error).toBeDefined();
    expect(error!.message).toContain('View for tool "send-mail"');
    expect(error!.message).not.toContain(missing);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      tool: "send-mail",
      uri: "ui://routecraft/send-mail",
    });
    expect(String(failures[0]!["error"])).toContain(missing);
  });

  /**
   * @case Reading a view that does not exist, or of a filtered-out tool, is not found
   * @preconditions send-mail with a view, hidden by the server's tools filter; a read of an unknown ui:// URI and of the hidden view
   * @expectedResult Both reads reject, the hidden tool's view is absent from resources/list
   */
  test("unknown and filtered-out views are not found", async () => {
    const connected = await connect(
      [sendMail({ ui: { html: MAIL_CARD } }), listTasks()],
      { tools: ["list-tasks"] },
    );

    expect((await connected.listResources()).resources).toEqual([]);
    await expect(
      connected.readResource({ uri: "ui://routecraft/send-mail" }),
    ).rejects.toThrow();
    await expect(
      connected.readResource({ uri: "ui://routecraft/nope" }),
    ).rejects.toThrow();
  });
});

describe("mcp({ ui }) validation", () => {
  /**
   * @case A view on a route without an output schema fails when the route starts
   * @preconditions Route with mcp({ ui }) and no .output()
   * @expectedResult startAndWaitReady rejects with RC5003 naming the route
   */
  test("ui requires .output()", async () => {
    const t = await testContext()
      .store(MCP_STORE_KEY, true)
      .routes([
        craft()
          .id("no-output")
          .description("Has a view but no output")
          .from(mcp({ ui: { html: MAIL_CARD } }))
          .transform(() => "x") as AnyRouteBuilder,
      ])
      .build();
    try {
      const error = await t.startAndWaitReady().then(
        () => undefined,
        (caught: unknown) => caught as { rc: string; message: string },
      );
      expect(error?.rc).toBe("RC5003");
      expect(error?.message).toContain('"no-output"');
    } finally {
      await t.stop();
    }
  });

  /**
   * @case A malformed ui option is rejected when mcp() is called
   * @preconditions ui.html empty or not a string or function; a csp list holding a non-string; prefersBorder not a boolean
   * @expectedResult Each mcp() call throws RC5003 before any route is built
   */
  test("malformed ui options throw at the call site", () => {
    const malformed: unknown[] = [
      { html: "   " },
      { html: 42 },
      { html: MAIL_CARD, csp: { connectDomains: [1] } },
      { html: MAIL_CARD, csp: { resourceDomains: "https://a.example" } },
      { html: MAIL_CARD, prefersBorder: "yes" },
    ];
    for (const ui of malformed) {
      expect(() => mcp({ ui } as unknown as McpServerOptions)).toThrow(
        expect.objectContaining({ rc: "RC5003" }),
      );
    }
  });
});

describe("mcpPlugin name and the view URI", () => {
  /**
   * @case An empty or blank server name is refused, since it would leave the ui:// URI without an authority
   * @preconditions mcpPlugin({ name: "" }) and mcpPlugin({ name: "  " })
   * @expectedResult Both throw a TypeError naming the option
   */
  test("mcpPlugin rejects an empty name", () => {
    expect(() => mcpPlugin({ name: "" })).toThrow(/name must not be empty/);
    expect(() => mcpPlugin({ name: "  " })).toThrow(/name must not be empty/);
  });

  /**
   * @case An explicit undefined name falls back to the default instead of spreading over it
   * @preconditions McpServer constructed with { name: undefined }, as untyped config produces from an unset environment variable
   * @expectedResult tools/list advertises ui://routecraft/send-mail, not ui://undefined/send-mail
   */
  test("an undefined name keeps the default", async () => {
    const t = await testContext()
      .store(MCP_STORE_KEY, true)
      .routes([sendMail({ ui: { html: MAIL_CARD } })])
      .build();
    try {
      const server = new McpServer(t.ctx, {
        name: undefined,
      } as unknown as McpPluginOptions);
      await t.startAndWaitReady();
      const tool = server
        .getAvailableTools()
        .find((candidate) => candidate.name === "send-mail");
      expect(tool?._meta?.ui?.resourceUri).toBe("ui://routecraft/send-mail");
      await server.stop();
    } finally {
      await t.stop();
    }
  });
});
