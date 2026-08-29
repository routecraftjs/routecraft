import { afterEach, describe, expect, test } from "bun:test";
import { bootServer, testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  cron,
  direct,
  getExchangeRoute,
  noop,
  opsPlugin,
  registerCapability,
  registerInternalEndpoint,
  type Exchange,
  type OpsPage,
  type OpsRouteSummary,
} from "../src/index.ts";
import { rcCodeOf } from "../src/brand.ts";

/**
 * `direct({ internal: true })`: a trusting subroutine keeps its in-process
 * endpoint and closes both external doors (ops dispatch, agent tools). The
 * cases that matter are the two refusals naming internal-ness, and the
 * proof that composition from another route is untouched.
 */
describe("direct({ internal: true })", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /** Forward to `endpoint` from inside a `.transform()`, via the bound route. */
  function forwardFrom(endpoint: string) {
    return async (body: unknown, ex: Exchange<unknown>): Promise<unknown> => {
      const forward = getExchangeRoute(ex)?.getForward(ex);
      return forward?.(endpoint as never, body as never);
    };
  }

  /**
   * Boot an instance with an internal subroutine, two boundary routes that
   * reach it both ways (enricher and forward), a no-door cron route, and
   * the ops surface open. Returns the bound port.
   */
  async function start(): Promise<number> {
    const booted = await bootServer((builder) =>
      builder
        .with({
          servers: { default: { port: 0, host: "127.0.0.1" } },
          plugins: [
            opsPlugin({ tiers: { introspection: true, dispatch: true } }),
          ],
        })
        .routes([
          craft()
            .id("resolve-order")
            .from(direct({ internal: true }))
            .transform((body) => ({ resolved: true, input: body })),
          craft().id("orders").from(direct()).to(direct("resolve-order")),
          craft()
            .id("orders-forwarding")
            .from(direct())
            .transform(forwardFrom("resolve-order")),
          craft().id("nightly").from(cron("0 0 * * *")).to(noop()),
        ]),
    );
    t = booted.ctx;
    return booted.port;
  }

  async function call<T>(
    port: number,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: T }> {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: init.method ?? "GET",
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await res.text();
    return {
      status: res.status,
      body: (text.length === 0 ? undefined : JSON.parse(text)) as T,
    };
  }

  /**
   * @case In-process composition against an internal route works unchanged
   * @preconditions An internal subroutine, one boundary route reaching it as a direct() enricher and one via forward()
   * @expectedResult Dispatching the boundary routes end to end returns the subroutine's answer both ways: the endpoint registry is untouched by internal-ness
   */
  test("stays composable through the enricher and forward", async () => {
    const port = await start();
    const viaEnricher = await call<{ outcome: string; body: unknown }>(
      port,
      "/ops/routes/orders/exchanges",
      { method: "POST", body: { orderId: "o-1" } },
    );
    expect(viaEnricher.status).toBe(200);
    expect(viaEnricher.body.body).toEqual({
      resolved: true,
      input: { orderId: "o-1" },
    });

    const viaForward = await call<{ outcome: string; body: unknown }>(
      port,
      "/ops/routes/orders-forwarding/exchanges",
      { method: "POST", body: { orderId: "o-2" } },
    );
    expect(viaForward.status).toBe(200);
    expect(viaForward.body.body).toEqual({
      resolved: true,
      input: { orderId: "o-2" },
    });
  });

  /**
   * @case An internal route is absent from the capability registry and visible as not dispatchable
   * @preconditions The instance above, introspection open
   * @expectedResult capabilities() lacks the subroutine while the listing still shows it with dispatchable false, and the dispatchable=false filter finds it alongside the cron route
   */
  test("skips the capability registry and reports dispatchable: false", async () => {
    const port = await start();
    const endpoints = t!.ctx.capabilities().map((c) => c.endpoint);
    expect(endpoints).toContain("orders");
    expect(endpoints).not.toContain("resolve-order");

    const listing = await call<OpsPage<OpsRouteSummary>>(port, "/ops/routes");
    const byId = new Map(listing.body.items.map((r) => [r.id, r]));
    expect(byId.get("resolve-order")?.dispatchable).toBe(false);
    expect(byId.get("orders")?.dispatchable).toBe(true);

    const filtered = await call<OpsPage<OpsRouteSummary>>(
      port,
      "/ops/routes?dispatchable=false",
    );
    expect(filtered.body.items.map((r) => r.id).sort()).toEqual([
      "nightly",
      "resolve-order",
    ]);
  });

  /**
   * @case The dispatch refusal distinguishes an internal route from one with no door
   * @preconditions The instance above, dispatch open; a POST to the internal route and one to the cron route
   * @expectedResult Both 409 RC5060, but the internal one names the declaration and the boundary-route remedy while the cron one keeps the add-a-direct-source advice: telling an internal route's caller to add .from(direct()) would be wrong advice for a route that has one
   */
  test("refuses dispatch by name, distinct from the no-door refusal", async () => {
    const port = await start();
    const internal = await call<{ code: string; message: string }>(
      port,
      "/ops/routes/resolve-order/exchanges",
      { method: "POST", body: {} },
    );
    expect(internal.status).toBe(409);
    expect(internal.body.code).toBe("RC5060");
    expect(internal.body.message).toMatch(/declared internal/);
    expect(internal.body.message).not.toMatch(/Add \.from\(direct\(\)\)/);

    const noDoor = await call<{ code: string; message: string }>(
      port,
      "/ops/routes/nightly/exchanges",
      { method: "POST", body: {} },
    );
    expect(noDoor.status).toBe(409);
    expect(noDoor.body.code).toBe("RC5060");
    expect(noDoor.body.message).toMatch(/Add \.from\(direct\(\)\)/);
    expect(noDoor.body.message).not.toMatch(/declared internal/);
  });

  /**
   * @case One endpoint declared both internal and a discoverable capability is refused loudly, in either order
   * @preconditions A bare context; registerInternalEndpoint then registerCapability for one endpoint, and the reverse on a second endpoint
   * @expectedResult RC5003 from whichever registration arrives second. Last-writer-wins would silently reopen the doors the internal declaration closed, on the unguarded subroutine the flag exists to protect
   */
  test("refuses a contradictory internal-and-capability declaration", async () => {
    t = await testContext().build();
    const ctx = t.ctx;

    registerInternalEndpoint(ctx, "subroutine");
    let secondCapability: unknown;
    try {
      registerCapability(ctx, { endpoint: "subroutine" });
    } catch (error: unknown) {
      secondCapability = error;
    }
    expect(rcCodeOf(secondCapability)).toBe("RC5003");
    expect((secondCapability as Error).message).toMatch(/declared internal/);

    registerCapability(ctx, { endpoint: "capability" });
    let secondInternal: unknown;
    try {
      registerInternalEndpoint(ctx, "capability");
    } catch (error: unknown) {
      secondInternal = error;
    }
    expect(rcCodeOf(secondInternal)).toBe("RC5003");
    expect((secondInternal as Error).message).toMatch(
      /discoverable capability/,
    );
  });
});
