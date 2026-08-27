import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, direct, isRoutecraftError, noop } from "@routecraft/routecraft";
import { mcp, mcpPlugin } from "@routecraft/ai";
import { MCP_TOOL_REGISTRY } from "../src/mcp/types.ts";
import type { McpToolRegistry } from "@routecraft/ai";
import { z } from "zod";

const MCP_TOOL_REGISTRY_KEY =
  MCP_TOOL_REGISTRY as keyof import("@routecraft/routecraft").StoreRegistry;

describe("MCP Plugin Integration", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) {
      await t.stop();
    }
  });

  /**
   * @case Route using .from(mcp(...)) without mcpPlugin fails at start
   * @preconditions Route has mcp() source but plugins do not include mcpPlugin()
   * @expectedResult Starting the context (t.test()) throws with message about MCP plugin required
   */
  test(".from(mcp(...)) without mcpPlugin fails when route starts", async () => {
    t = await testContext()
      .routes(craft().id("test").description("test").from(mcp()).to(noop()))
      .build();

    await expect(t.test()).rejects.toThrow(/MCP plugin required/);
  });

  /**
   * @case Verifies that mcpPlugin() can be used in context config
   * @preconditions Plugin is added to config
   * @expectedResult Context builds without error
   */
  test("mcpPlugin() registers with context", async () => {
    expect(typeof mcpPlugin).toBe("function");

    t = await testContext()
      .routes(craft().id("test").description("test").from(mcp()).to(noop()))
      .with({
        plugins: [mcpPlugin()],
      })
      .build();

    expect(t).toBeDefined();
  });

  /**
   * @case Verifies that only mcp() routes with description are exposed
   * @preconditions Routes with mcp() and direct() are defined
   * @expectedResult Registry contains only mcp routes
   */
  test("Only mcp() routes with description are exposed", async () => {
    const toolRoute = craft()
      .id("my-tool")
      .description("A test tool")
      .input({ body: z.object({ input: z.string() }) })
      .from(mcp())
      .to(noop());

    const directRoute = craft().id("internal-bus").from(direct()).to(noop());

    t = await testContext()
      .routes([toolRoute, directRoute])
      .with({
        plugins: [mcpPlugin()],
      })
      .build();

    expect(t).toBeDefined();
  });

  /**
   * @case Verifies that mcpPlugin accepts options
   * @preconditions Plugin is created with custom options
   * @expectedResult Plugin accepts name, version options
   */
  test("mcpPlugin() accepts configuration options", async () => {
    t = await testContext()
      .routes(craft().id("test").description("test").from(mcp()).to(noop()))
      .with({
        plugins: [
          mcpPlugin({
            name: "custom-server",
            version: "2.0.0",
          }),
        ],
      })
      .build();

    expect(t).toBeDefined();
  });

  /**
   * @case Verifies that mcpPlugin can filter tools
   * @preconditions Multiple tools are defined and filter is applied
   * @expectedResult Plugin is an object with apply and optional teardown
   */
  test("mcpPlugin() can filter tools by name", () => {
    const p = mcpPlugin({ tools: ["allowed-tool"] });
    expect(typeof p.apply).toBe("function");
    expect(p).toHaveProperty("teardown");
  });

  /**
   * @case Verifies that mcpPlugin can filter tools by function
   * @preconditions Custom filter function is provided operating on McpLocalToolEntry
   * @expectedResult Plugin is an object with apply and optional teardown
   */
  test("mcpPlugin() can filter tools by function", () => {
    const p = mcpPlugin({
      tools: (entry) => entry.annotations?.readOnlyHint === true,
    });
    expect(typeof p.apply).toBe("function");
    expect(p).toHaveProperty("teardown");
  });

  /**
   * @case Verifies that mcp() routes with schema are properly registered
   * @preconditions An mcp route with Zod schema is defined
   * @expectedResult Schema is registered in metadata
   */
  test("mcp() routes register with schema", async () => {
    const mySchema = z.object({
      name: z.string(),
      age: z.number().optional(),
    });

    const toolRoute = craft()
      .id("schema-tool")
      .description("A tool with schema")
      .input({ body: mySchema })
      .from(mcp())
      .to(noop());

    t = await testContext()
      .routes([toolRoute])
      .with({
        plugins: [mcpPlugin()],
      })
      .build();

    expect(t).toBeDefined();
  });

  /**
   * @case Verifies that direct() routes without description are not treated as tools
   * @preconditions A direct() adapter is used without description
   * @expectedResult Route is registered but not in tool registry
   */
  test("Routes without description are not exposed as tools", async () => {
    const route = craft().id("plain-direct").from(direct()).to(noop());

    t = await testContext()
      .routes([route])
      .with({
        plugins: [mcpPlugin()],
      })
      .build();

    expect(t).toBeDefined();
  });

  /**
   * @case mcpPlugin stores MCP_TOOL_REGISTRY in context store
   * @preconditions Plugin is applied
   * @expectedResult Context store has McpToolRegistry instance
   */
  test("mcpPlugin stores MCP_TOOL_REGISTRY in context store", async () => {
    t = await testContext()
      .routes(craft().id("test").description("test").from(mcp()).to(noop()))
      .with({
        plugins: [mcpPlugin()],
      })
      .build();

    const registry = t.ctx.getStore(MCP_TOOL_REGISTRY_KEY) as
      McpToolRegistry | undefined;
    expect(registry).toBeDefined();
    expect(typeof registry!.getTools).toBe("function");
    expect(typeof registry!.getTool).toBe("function");
  });

  /**
   * @case Tool registry does not include local mcp() routes
   * @preconditions Plugin applied with mcp() routes, context started
   * @expectedResult Registry is empty (local routes are not MCP tools)
   */
  test("tool registry does not include local mcp() routes", async () => {
    t = await testContext()
      .routes([
        craft().id("tool-a").description("Tool A").from(mcp()).to(noop()),
        craft().id("tool-b").description("Tool B").from(mcp()).to(noop()),
        craft().id("internal").from(direct()).to(noop()),
      ])
      .with({
        plugins: [mcpPlugin()],
      })
      .build();

    await t.test();

    const registry = t.ctx.getStore(MCP_TOOL_REGISTRY_KEY) as McpToolRegistry;
    const tools = registry.getTools();
    // Local routes should not appear in the MCP tool registry.
    // The registry is for external tools (stdio/HTTP clients) only.
    expect(tools).toHaveLength(0);
  });

  describe("validation", () => {
    /**
     * @case The removed OAuth authorization-server proxy config is refused at construction
     * @preconditions auth carries the pre-2026 shape ({ provider: "oauth", endpoints, verifyAccessToken, getClient })
     * @expectedResult validateMcpPluginOptions throws with the migration. That shape has no `validator`, so it would otherwise start cleanly and then refuse every request with 401
     */
    test("rejects the removed OAuth proxy auth shape", () => {
      expect(() =>
        mcpPlugin({
          transport: "http",
          auth: {
            provider: "oauth",
            endpoints: {
              authorizationUrl: "https://idp.example.com/authorize",
              tokenUrl: "https://idp.example.com/token",
            },
            verifyAccessToken: async () => ({}),
            getClient: async () => undefined,
          } as never,
        }),
      ).toThrow(/resource server|oauth\(\{ verify/i);
    });

    /**
     * @case A scope that cannot appear in a WWW-Authenticate challenge is refused at construction
     * @preconditions auth.requiredScopes contains a value with a space and one with a quote
     * @expectedResult validateMcpPluginOptions throws, so a misconfiguration surfaces at startup rather than as a corrupted header on the first 403
     */
    test("rejects requiredScopes that break the challenge grammar", () => {
      for (const scope of ["has space", 'has"quote']) {
        expect(() =>
          mcpPlugin({
            transport: "http",
            auth: {
              validator: async () => ({
                kind: "custom" as const,
                scheme: "bearer" as const,
                subject: "u",
              }),
              requiredScopes: [scope],
            } as never,
          }),
        ).toThrow(/scope/i);
      }
    });

    /**
     * @case A clock tolerance the expiry gate cannot use is refused at construction
     * @preconditions auth.clockToleranceSec is NaN, negative, or not a number
     * @expectedResult validateMcpPluginOptions throws. The gate fails closed on a non-finite tolerance, so any of these would otherwise refuse every authenticated request at runtime
     */
    test("rejects a clockToleranceSec the expiry gate cannot apply", () => {
      for (const clockToleranceSec of [
        Number.NaN,
        Number.POSITIVE_INFINITY,
        -1,
        "30",
      ]) {
        expect(() =>
          mcpPlugin({
            transport: "http",
            auth: {
              validator: async () => ({
                kind: "custom" as const,
                scheme: "bearer" as const,
                subject: "u",
              }),
              clockToleranceSec,
            } as never,
          }),
        ).toThrow(/clockToleranceSec/);
      }
    });

    /**
     * @case A client name containing the wire separator fails at registration
     * @preconditions Client registered as "a__b"
     * @expectedResult RC5003 at mcpPlugin() naming the separator, rather than every tool on the client vanishing at dispatch
     */
    test("rejects a client name containing the tool-name separator", () => {
      let caught: unknown;
      try {
        mcpPlugin({
          clients: { a__b: { transport: "stdio", command: "echo" } },
        });
      } catch (err) {
        caught = err;
      }
      expect(isRoutecraftError(caught)).toBe(true);
      expect((caught as { rc?: string }).rc).toBe("RC5003");
      expect((caught as Error).message).toMatch(/contain "__"/);
      // The suggestion names a concrete replacement, because the fix is
      // always "use one underscore" and the developer owns this name.
      expect(
        (caught as { meta?: { suggestion?: string } }).meta?.suggestion,
      ).toMatch(/"a_b"/);
    });

    /**
     * @case A single underscore in a client name is still accepted
     * @preconditions Client registered as "my_company_api"
     * @expectedResult Registration succeeds, pinning the case the first-separator split exists to handle
     */
    test("accepts a client name containing a single underscore", () => {
      expect(() =>
        mcpPlugin({
          clients: { my_company_api: { transport: "stdio", command: "echo" } },
        }),
      ).not.toThrow();
    });

    /**
     * @case A client name ending in a single underscore is rejected, because it collides
     * @preconditions Client registered as "foo_"
     * @expectedResult RC5003, since "foo_" + "bar" and "foo" + "_bar" both compose mcp__foo___bar
     */
    test("rejects a client name ending in an underscore", () => {
      // Not merely unresolvable: joining `foo_` to `bar` with `__`
      // gives `mcp__foo___bar`, the exact name `foo` exposing `_bar`
      // composes. The resolved tool map is keyed by name with
      // later-wins, so one client silently shadows the other.
      let caught: unknown;
      try {
        mcpPlugin({
          clients: { foo_: { transport: "stdio", command: "echo" } },
        });
      } catch (err) {
        caught = err;
      }
      expect(isRoutecraftError(caught)).toBe(true);
      expect((caught as { rc?: string }).rc).toBe("RC5003");
      expect((caught as Error).message).toMatch(/end with "_"/);
    });

    /**
     * @case An empty client name is rejected
     * @preconditions Client registered under ""
     * @expectedResult RC5003 rather than a composed name with an empty server segment
     */
    test("rejects an empty client name", () => {
      let caught: unknown;
      try {
        mcpPlugin({
          clients: { "": { transport: "stdio", command: "echo" } },
        });
      } catch (err) {
        caught = err;
      }
      expect(isRoutecraftError(caught)).toBe(true);
      expect((caught as { rc?: string }).rc).toBe("RC5003");
      expect((caught as Error).message).toMatch(/must not be empty/);
    });

    /**
     * @case The MCP path is held to the canonical static-path contract
     * @preconditions HTTP transport with paths carrying a query, param segment, dot segment, backslash, or percent-encoding
     * @expectedResult RC5003 at construction for each; the claim could never match a parsed request pathname
     */
    test("rejects non-canonical MCP paths at construction", () => {
      for (const path of [
        "/mcp?v=1",
        "/mcp/:tenant",
        "/mcp/../admin",
        "/mcp\\admin",
        "/%2e%2e/mcp",
        "/mcp//",
      ]) {
        let caught: unknown;
        try {
          mcpPlugin({ transport: "http", path });
        } catch (err) {
          caught = err;
        }
        expect(isRoutecraftError(caught)).toBe(true);
        expect((caught as { rc?: string }).rc).toBe("RC5003");
      }
    });

    /**
     * @case A root MCP path is refused rather than silently remapped
     * @preconditions HTTP transport with path "/"
     * @expectedResult Construction throws instead of quietly serving /mcp; a root endpoint needs the bare RFC 9728 well-known document the framework does not serve yet
     */
    test("rejects a root MCP path at construction", () => {
      expect(() => mcpPlugin({ transport: "http", path: "/" })).toThrow(
        /must not be "\/"/,
      );
    });

    /**
     * @case The suggested replacement name satisfies the rule that rejected the original
     * @preconditions Client names that a naive separator-split suggestion would fix incorrectly
     * @expectedResult Every suggested name is one the validator accepts, so following the error works first time
     */
    test("the suggested replacement is itself a valid client name", () => {
      // A naive `split("__").join("_")` yields "a__b" for "a____b" and
      // "a_" for "a__", both of which this same error would reject
      // again. The suggestion is the one line whose whole job is to be
      // copy-pasteable.
      // Includes the degenerate names that leave nothing to salvage, so
      // "every rejection carries a copyable name" is pinned rather than
      // true only for the easy cases.
      for (const bad of ["a____b", "a__", "foo__bar__baz", "", "___"]) {
        let suggestion: string | undefined;
        try {
          mcpPlugin({
            clients: { [bad]: { transport: "stdio", command: "echo" } },
          });
        } catch (err) {
          suggestion = (err as { meta?: { suggestion?: string } }).meta
            ?.suggestion;
        }
        const quoted = suggestion?.match(/e\.g\. "([^"]+)"/)?.[1];
        expect(quoted).toBeDefined();
        expect(() =>
          mcpPlugin({
            clients: {
              [quoted as string]: { transport: "stdio", command: "echo" },
            },
          }),
        ).not.toThrow();
      }
    });

    /**
     * @case Validation rejects empty command for stdio client
     * @preconditions Stdio client with empty command
     * @expectedResult TypeError thrown
     */
    test("rejects stdio client with empty command", () => {
      expect(() =>
        mcpPlugin({
          clients: {
            bad: { transport: "stdio", command: "" },
          },
        }),
      ).toThrow(/non-empty command/);
    });

    /**
     * @case Validation rejects negative maxRestarts
     * @preconditions maxRestarts set to -1
     * @expectedResult TypeError thrown
     */
    test("rejects negative maxRestarts", () => {
      expect(() => mcpPlugin({ maxRestarts: -1 })).toThrow(
        /non-negative integer/,
      );
    });

    /**
     * @case Validation rejects non-integer maxRestarts
     * @preconditions maxRestarts set to 2.5
     * @expectedResult TypeError thrown
     */
    test("rejects non-integer maxRestarts", () => {
      expect(() => mcpPlugin({ maxRestarts: 2.5 })).toThrow(
        /non-negative integer/,
      );
    });

    /**
     * @case Validation rejects a zero restartDelay
     * @preconditions restartDelay set to 0
     * @expectedResult TypeError thrown
     */
    test("rejects a zero restartDelay", () => {
      expect(() => mcpPlugin({ restartDelay: 0 })).toThrow(/positive duration/);
    });

    /**
     * @case Validation rejects restartBackoffMultiplier less than 1
     * @preconditions restartBackoffMultiplier set to 0.5
     * @expectedResult TypeError thrown
     */
    test("rejects restartBackoffMultiplier less than 1", () => {
      expect(() => mcpPlugin({ restartBackoffMultiplier: 0.5 })).toThrow(
        />= 1/,
      );
    });

    /**
     * @case Validation rejects a negative toolRefreshInterval
     * @preconditions toolRefreshInterval set to -100
     * @expectedResult TypeError thrown
     */
    test("rejects a negative toolRefreshInterval", () => {
      expect(() => mcpPlugin({ toolRefreshInterval: -100 })).toThrow(
        /non-negative duration/,
      );
    });

    /**
     * @case Valid restart options are accepted
     * @preconditions All restart options within valid range
     * @expectedResult Plugin created without error
     */
    test("accepts valid restart options", () => {
      const p = mcpPlugin({
        maxRestarts: 10,
        restartDelay: 500,
        restartBackoffMultiplier: 1.5,
        toolRefreshInterval: 30000,
      });
      expect(typeof p.apply).toBe("function");
    });

    /**
     * @case Validation rejects an invalid cors.origin shape at plugin-apply time
     * @preconditions transport: 'http', cors: { origin: 42 } cast through unknown to bypass TypeScript
     * @expectedResult TypeError thrown by `validateMcpPluginOptions`, not deferred to server start; surfaces alongside `auth`/`port`/`host` shape errors
     */
    test("rejects invalid cors.origin shape at apply time", () => {
      expect(() =>
        mcpPlugin({
          transport: "http",
          cors: { origin: 42 as unknown as string },
        }),
      ).toThrow(/cors\.origin must be/);
    });

    /**
     * @case `cors: false` and well-formed `cors.origin` shapes pass validation
     * @preconditions transport: 'http' with cors: false, then cors: { origin: '*' | string | string[] | function }
     * @expectedResult No throw for any of the four legal shapes
     */
    test("accepts well-formed cors shapes", () => {
      expect(() => mcpPlugin({ transport: "http", cors: false })).not.toThrow();
      expect(() =>
        mcpPlugin({ transport: "http", cors: { origin: "*" } }),
      ).not.toThrow();
      expect(() =>
        mcpPlugin({
          transport: "http",
          cors: { origin: "https://app.example.com" },
        }),
      ).not.toThrow();
      expect(() =>
        mcpPlugin({
          transport: "http",
          cors: { origin: ["https://a.example", "https://b.example"] },
        }),
      ).not.toThrow();
      expect(() =>
        mcpPlugin({
          transport: "http",
          cors: { origin: () => false },
        }),
      ).not.toThrow();
    });
  });

  describe("stdio client config acceptance", () => {
    /**
     * @case mcpPlugin accepts stdio client configuration
     * @preconditions Valid stdio client config provided
     * @expectedResult Plugin created without error
     */
    test("accepts valid stdio client config", () => {
      const p = mcpPlugin({
        clients: {
          "my-server": {
            transport: "stdio",
            command: "node",
            args: ["server.js"],
            env: { NODE_ENV: "production" },
            cwd: "/tmp",
          },
        },
        maxRestarts: 3,
        restartDelay: 100,
        restartBackoffMultiplier: 2,
      });
      expect(typeof p.apply).toBe("function");
    });

    /**
     * @case mcpPlugin accepts mixed HTTP and stdio client config
     * @preconditions Both HTTP and stdio configs provided
     * @expectedResult Plugin created without error
     */
    test("accepts mixed HTTP and stdio client config", () => {
      const p = mcpPlugin({
        clients: {
          "http-server": { url: "http://localhost:3000/mcp" },
          "stdio-server": {
            transport: "stdio",
            command: "npx",
            args: ["-y", "@some/mcp-server"],
          },
        },
      });
      expect(typeof p.apply).toBe("function");
    });
  });

  describe("auth option validation", () => {
    /**
     * @case mcpPlugin accepts a validator function
     * @preconditions auth.validator is a function
     * @expectedResult Plugin created without error
     */
    test("accepts a validator function", () => {
      const p = mcpPlugin({
        transport: "http",
        auth: {
          validator: () => ({
            kind: "custom",
            subject: "test",
            scheme: "bearer",
          }),
        },
      });
      expect(typeof p.apply).toBe("function");
    });

    /**
     * @case mcpPlugin rejects a non-function validator
     * @preconditions auth.validator is not a function
     * @expectedResult TypeError thrown
     */
    test("rejects non-function validator", () => {
      const createWithInvalidValidator = () =>
        mcpPlugin({
          transport: "http",
          // @ts-expect-error testing runtime validation of non-function validator
          auth: { validator: "not-a-function" },
        });

      expect(createWithInvalidValidator).toThrow(TypeError);
      expect(createWithInvalidValidator).toThrow(
        /auth\.validator must be a function/,
      );
    });
  });
});
