import { describe, expect, test, afterEach } from "bun:test";
import { testContext, signHs256, type TestContext } from "@routecraft/testing";
import {
  buildProtectedResourceMetadata,
  craft,
  direct,
  http,
  jwt,
  noop,
  opsPlugin,
  resourceMetadataUrlFor,
  type ProtectedResourceMetadata,
} from "../src/index.ts";
import { HttpMountRegistry } from "../src/plugins/server/registry.ts";

const SECRET = "protected-resource-test-secret-please-change";
const ISSUER = "https://idp.test";
const AUDIENCE = "https://api.test";

/**
 * RFC 9728 protected-resource metadata: the shared builder, the ingress
 * serving fallback, and the resource_metadata hint on refusals.
 */
describe("protected resource metadata", () => {
  /**
   * @case The builder omits everything it was not given
   * @preconditions Only a resource URL
   * @expectedResult A document carrying the resource identity and bearer method, with no invented issuer, scopes, name, or documentation
   */
  test("builds an honest minimal document", () => {
    expect(
      buildProtectedResourceMetadata({ resource: "http://rs.test" }),
    ).toEqual({
      resource: "http://rs.test",
      bearer_methods_supported: ["header"],
    });
  });

  /**
   * @case A single issuer and a scope list round-trip into the RFC fields
   * @preconditions Issuer as a plain string, two scopes, a name and documentation URL
   * @expectedResult authorization_servers is the one-element array form, scopes_supported and the naming fields carry through verbatim
   */
  test("carries issuer, scopes, and naming fields", () => {
    expect(
      buildProtectedResourceMetadata({
        resource: "http://rs.test/ops",
        issuer: ISSUER,
        scopesSupported: ["ops:dispatch", "ops:introspection"],
        resourceName: "orders",
        documentationUrl: "https://docs.test",
      }),
    ).toEqual({
      resource: "http://rs.test/ops",
      resource_name: "orders",
      authorization_servers: [ISSUER],
      bearer_methods_supported: ["header"],
      scopes_supported: ["ops:dispatch", "ops:introspection"],
      resource_documentation: "https://docs.test",
    });
  });

  /**
   * @case The hint URL inserts the well-known prefix between origin and path
   * @preconditions A request URL with a path, and one at the root
   * @expectedResult RFC 9728 section 3.1 path insertion; the root collapses to the bare well-known path rather than one with a trailing slash
   */
  test("derives the resource_metadata URL per RFC 9728 path insertion", () => {
    expect(resourceMetadataUrlFor("http://127.0.0.1:8080/ops/routes?x=1")).toBe(
      "http://127.0.0.1:8080/.well-known/oauth-protected-resource/ops/routes",
    );
    expect(resourceMetadataUrlFor("http://127.0.0.1:8080/")).toBe(
      "http://127.0.0.1:8080/.well-known/oauth-protected-resource",
    );
  });

  /**
   * @case The ingress answers metadata paths no mount claims
   * @preconditions A registry with a walled mount (jwt auth, declared scopes) at /ops and no claim on the well-known namespace
   * @expectedResult The suffixed document for an owned path carries the mount's issuer and declared scopes; the root document falls back to the server level and stays minimal
   */
  test("serves suffixed documents from the owning mount's effective auth", async () => {
    const context = (await testContext().build()).ctx;
    const ingress = new HttpMountRegistry("public", context);
    ingress.mountHttp({
      id: "ops",
      auth: jwt({ secret: SECRET, issuer: ISSUER, audience: AUDIENCE }),
      resourceMetadata: { scopesSupported: ["ops:dispatch"] },
      claims: () => [{ kind: "prefix", path: "/ops" }],
      handler: () => new Response("ops"),
    });
    ingress.validate();

    const suffixed = await ingress.dispatch(
      new Request(
        "http://local:8080/.well-known/oauth-protected-resource/ops/routes",
      ),
    );
    expect(suffixed.status).toBe(200);
    const doc = (await suffixed.json()) as ProtectedResourceMetadata;
    expect(doc.resource).toBe("http://local:8080/ops/routes");
    expect(doc.authorization_servers).toEqual([ISSUER]);
    expect(doc.scopes_supported).toEqual(["ops:dispatch"]);

    const root = await ingress.dispatch(
      new Request("http://local:8080/.well-known/oauth-protected-resource"),
    );
    expect(root.status).toBe(200);
    const rootDoc = (await root.json()) as ProtectedResourceMetadata;
    expect(rootDoc.resource).toBe("http://local:8080");
    expect(rootDoc.authorization_servers).toBeUndefined();
    expect(rootDoc.scopes_supported).toBeUndefined();
  });

  /**
   * @case A catch-all mount does not swallow the well-known namespace, an exact claim does
   * @preconditions One "/" prefix mount, one mount claiming its metadata path exactly (the MCP pattern)
   * @expectedResult The exact claim is dispatched to its own handler; a metadata path under the catch-all is answered by the ingress instead of the catch-all's 404
   */
  test("prefix claims lose the metadata namespace, exact claims keep it", async () => {
    const context = (await testContext().build()).ctx;
    const ingress = new HttpMountRegistry("public", context);
    ingress.mountHttp({
      id: "http",
      claims: () => [{ kind: "prefix", path: "/" }],
      handler: () => new Response("caught-all", { status: 404 }),
    });
    ingress.mountHttp({
      id: "mcp",
      claims: () => [
        {
          kind: "exact",
          path: "/.well-known/oauth-protected-resource/mcp",
          methods: ["GET", "OPTIONS"],
        },
      ],
      handler: () => new Response("mcp-doc"),
    });
    ingress.validate();

    expect(
      await (
        await ingress.dispatch(
          new Request("http://local/.well-known/oauth-protected-resource/mcp"),
        )
      ).text(),
    ).toBe("mcp-doc");

    const ingressServed = await ingress.dispatch(
      new Request("http://local/.well-known/oauth-protected-resource/orders"),
    );
    expect(ingressServed.status).toBe(200);
    expect(
      ((await ingressServed.json()) as ProtectedResourceMetadata).resource,
    ).toBe("http://local/orders");

    // Anything else under the catch-all still reaches its handler.
    expect(
      (await ingress.dispatch(new Request("http://local/nope"))).status,
    ).toBe(404);
  });
});

/**
 * The discovery walk end to end: refusals hint, the hint resolves, the
 * document names the issuer. This is what the CLI follows.
 */
describe("discovery on refusals", () => {
  let t: TestContext | undefined;
  afterEach(async () => {
    if (t) {
      await t.stop();
      t = undefined;
    }
  });

  async function boot(): Promise<string> {
    let port: number | undefined;
    t = await testContext()
      .routes([
        craft()
          .id("orders")
          .from(http({ path: "/orders", method: "GET" }))
          .transform(() => "ok")
          .to(noop()),
        craft().id("dispatchable").from(direct()).to(noop()),
      ])
      .with({
        servers: {
          default: {
            port: 0,
            host: "127.0.0.1",
            auth: jwt({ secret: SECRET, issuer: ISSUER, audience: AUDIENCE }),
          },
        },
        http: {},
        plugins: [opsPlugin({ tiers: { dispatch: "ops:dispatch" } })],
      })
      .build();
    t.ctx.on("server:listening", ({ details }) => {
      port = details.port;
    });
    await t.startAndWaitReady();
    if (port === undefined) throw new Error("no port");
    return `http://127.0.0.1:${String(port)}`;
  }

  /**
   * @case A 401 on a walled http mount carries the resource_metadata hint, and the hint resolves
   * @preconditions Server-level jwt auth, a plain http route, no credential presented
   * @expectedResult The challenge names a metadata URL mirroring the request path; fetching it returns the issuer the wall verifies against
   */
  test("walled http route 401 hints at a resolvable document", async () => {
    const base = await boot();
    const refused = await fetch(`${base}/orders`);
    expect(refused.status).toBe(401);
    const challenge = refused.headers.get("www-authenticate") ?? "";
    const match = /resource_metadata="([^"]+)"/.exec(challenge);
    expect(match?.[1]).toBe(
      `${base}/.well-known/oauth-protected-resource/orders`,
    );
    const doc = await fetch(match![1]!);
    expect(doc.status).toBe(200);
    const body = (await doc.json()) as ProtectedResourceMetadata;
    expect(body.authorization_servers).toEqual([ISSUER]);
  });

  /**
   * @case A scope refusal on the ops dispatch tier hints too, and the document names the tier scope
   * @preconditions Dispatch tier gated on ops:dispatch, a verified token without that scope
   * @expectedResult 403 whose challenge carries scope and resource_metadata; the document lists ops:dispatch in scopes_supported and the issuer to go back to
   */
  test("ops scope refusal hints at a document naming the missing scope", async () => {
    const base = await boot();
    const token = signHs256({
      secret: SECRET,
      claims: { scope: "something-else" },
    });
    const refused = await fetch(`${base}/ops/routes/dispatchable/exchanges`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(refused.status).toBe(403);
    const challenge = refused.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain('scope="ops:dispatch"');
    const match = /resource_metadata="([^"]+)"/.exec(challenge);
    expect(match?.[1]).toBeDefined();
    const doc = await fetch(match![1]!);
    expect(doc.status).toBe(200);
    const body = (await doc.json()) as ProtectedResourceMetadata;
    expect(body.authorization_servers).toEqual([ISSUER]);
    expect(body.scopes_supported).toEqual(["ops:dispatch"]);
  });
});
