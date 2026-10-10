import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  HeadersKeys,
  MemoryDeferralStore,
  authenticate,
  authorityOf,
  craft,
  definePlugin,
  deferredPrincipal,
  direct,
  noop,
  reviveDeferral,
  type Execution,
  type PluginRoutes,
  type Principal,
} from "../src/index.ts";
import { isAuthentic } from "../src/auth/authentic.ts";
import { asDeferred } from "./helpers/deferral.ts";

const SECRET = "resume-reidentify-test-secret-0123456789";

const Approval = z.object({ approved: z.boolean() });

/** The identity every park in this file is made under, verified live now. */
function member(
  overrides: { roles?: string[]; scopes?: string[] } = {},
): Principal {
  return authenticate({
    subject: "member-1",
    email: "member@acme.test",
    roles: overrides.roles ?? ["member"],
    scopes: overrides.scopes ?? ["orders:read", "orders:write"],
  });
}

/**
 * A plugin's view of the application, captured at bind: the same
 * `execution` and `routes` a third-party plugin reviving a parked exchange
 * on its own behalf is handed.
 */
function reviver(): {
  plugin: ReturnType<typeof definePlugin>;
  execution: () => Execution;
  routes: () => PluginRoutes;
} {
  let execution: Execution | undefined;
  let routes: PluginRoutes | undefined;
  return {
    plugin: definePlugin({
      id: "test.reviver",
      bind(c) {
        execution = c.execution;
        routes = c.routes;
      },
    }),
    execution: () => execution!,
    routes: () => routes!,
  };
}

/**
 * `execution.resume(request, { reidentified })`: a plugin revives a parked
 * exchange under the identity it parked with, re-verified live, and nothing
 * else.
 */
describe("a plugin-driven revival with a re-identified principal", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  async function build(seen: Array<Principal | undefined>) {
    const store = new MemoryDeferralStore();
    const host = reviver();
    t = await testContext()
      .with({
        deferral: { store, secret: SECRET },
        plugins: [host.plugin],
      })
      .routes([
        craft()
          .id("work")
          .from(direct())
          .defer({ schema: Approval })
          .tap((ex) => {
            seen.push(ex.auth.principal);
          })
          .to(noop()),
        craft().id("plain").from(direct()).to(noop()),
      ])
      .build();
    await t.startAndWaitReady();
    const park = async () =>
      asDeferred(
        await t!.client.sendDirect(
          "work",
          {},
          { [HeadersKeys.AUTH_PRINCIPAL]: member() },
        ),
      );
    return { store, host, park };
  }

  /**
   * @case Anything but the parked identity verified live is refused, non-destructively
   * @preconditions Four parks, revived through execution.resume with the parked principal read back restored, the same subject with a different role, with an added scope, and with a dropped scope
   * @expectedResult Each revival is RC5056 with the re-identification message, no continuation runs, and every record is left waiting, unclaimed and unsettled
   */
  test("a restored, re-roled, widened or narrowed principal is refused", async () => {
    const seen: Array<Principal | undefined> = [];
    const { store, host, park } = await build(seen);
    const authority = authorityOf(t!.ctx);

    const candidates: Array<(parked: string) => Promise<Principal>> = [
      async (deferralId) =>
        deferredPrincipal((await store.get(deferralId))!, authority)!,
      async () => member({ roles: ["admin"] }),
      async () =>
        member({ scopes: ["orders:read", "orders:write", "orders:delete"] }),
      async () => member({ scopes: ["orders:read"] }),
    ];

    for (const candidate of candidates) {
      const deferred = await park();
      const reidentified = await candidate(deferred.deferralId);
      const refusal = await host
        .execution()
        .resume(
          { token: deferred.token, result: { approved: true } },
          { reidentified },
        )
        .then(
          () => undefined,
          (err: unknown) => err as { rc?: string; message?: string },
        );

      expect(refusal?.rc).toBe("RC5056");
      expect(refusal?.message).toMatch(/re-identified/);
      expect(refusal?.message).not.toMatch(/hook/);
      const untouched = await store.get(deferred.deferralId);
      expect(untouched?.state).toBe("waiting");
      expect(untouched?.claim).toBeUndefined();
      expect(untouched?.outcome).toBeUndefined();
    }
    expect(seen).toHaveLength(0);
  });

  /**
   * @case The parked identity, verified live again, revives the continuation
   * @preconditions A park under a member principal, revived through execution.resume with a freshly authenticated principal carrying the same subject, roles and scopes
   * @expectedResult The revival completes, the continuation sees that exact principal and it is authentic rather than restored, and the record settles as resumed
   */
  test("the same identity verified live runs the continuation as itself", async () => {
    const seen: Array<Principal | undefined> = [];
    const { store, host, park } = await build(seen);
    const deferred = await park();
    const live = member();

    const ack = await host
      .execution()
      .resume(
        { token: deferred.token, result: { approved: true } },
        { reidentified: live },
      );

    expect(ack.continuation.status).toBe("completed");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(live);
    expect(isAuthentic(seen[0])).toBe(true);
    expect((await store.get(deferred.deferralId))?.outcome?.kind).toBe(
      "resumed",
    );
  });

  /**
   * @case One revival cannot carry both an elevate hook and a re-identified principal
   * @preconditions A park, revived through reviveDeferral with a door carrying elevate and reidentified together
   * @expectedResult RC5003 before the token is read, so neither the hook runs nor the record moves; with both set, one of the two answers would otherwise be discarded silently
   */
  test("elevate and reidentified together are refused with RC5003", async () => {
    const seen: Array<Principal | undefined> = [];
    const { store, park } = await build(seen);
    const deferred = await park();
    let elevated = 0;

    const refusal = await reviveDeferral(
      t!.ctx,
      { token: deferred.token, result: { approved: true } },
      {
        elevate: () => {
          elevated++;
          return member();
        },
        reidentified: member(),
      },
    ).then(
      () => undefined,
      (err: unknown) => err as { rc?: string },
    );

    expect(refusal?.rc).toBe("RC5003");
    expect(elevated).toBe(0);
    expect(seen).toHaveLength(0);
    const untouched = await store.get(deferred.deferralId);
    expect(untouched?.state).toBe("waiting");
    expect(untouched?.claim).toBeUndefined();
  });

  /**
   * @case A plugin asks whether a route can park
   * @preconditions A route with a .defer(), a plain route, and an id no route has, with no error hook declaring mayDefer
   * @expectedResult routes.canDefer is true for the deferring route and false for the plain route and for the unknown id
   */
  test("routes.canDefer answers per route", async () => {
    const { host } = await build([]);

    expect(host.routes().canDefer("work")).toBe(true);
    expect(host.routes().canDefer("plain")).toBe(false);
    expect(host.routes().canDefer("nowhere")).toBe(false);
  });
});
