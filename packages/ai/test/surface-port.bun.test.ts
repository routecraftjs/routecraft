/**
 * The surfaces are a port, not a store key.
 *
 * A backend publishes connections and turns into the state the surfaces
 * plugin provides, and every `surface()` step resolves against the same
 * state through the exchange's application. These cases pin what that
 * buys: one state per application, the ACP mount bringing the provider
 * along rather than reaching past the plugin boundary, an application
 * with no backend reading as no surface, and the lifecycle bounded by the
 * plugin that owns it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { DefaultExchange, HeadersKeys, rcCodeOf } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import { hasSurface, surface } from "../src/index.ts";
import {
  SURFACES,
  registerSurface,
  surfacesPlugin,
} from "../src/surface/index.ts";
import {
  cancelSurfaceTurn,
  registerCleanup,
  turnSignalOf,
} from "../src/surface/cancellation.ts";
import { acpHarness, type AcpHarness } from "./helpers/acp-harness.ts";
import { MODEL } from "./helpers/defer-fixtures.ts";
import {
  SURFACE_CONNECTION,
  SURFACED,
  keepAlive,
  scriptedSurface,
  surfacesOf,
  surfacing,
} from "./helpers/surface-stub.ts";
import { until } from "./helpers/until.ts";

const AGENTS = {
  max: {
    description: "Max",
    model: MODEL,
    system: "be useful",
  },
};

const REF = {
  kind: "acp" as const,
  session: "s",
  connection: SURFACE_CONNECTION,
};

describe("the surfaces port", () => {
  const contexts: TestContext[] = [];
  let h: AcpHarness | undefined;

  afterEach(async () => {
    for (const t of contexts.splice(0)) await t.stop();
    if (h) await h.t.stop();
    h = undefined;
  });

  async function application(
    config = surfacing(),
    routes = [keepAlive],
  ): Promise<TestContext> {
    const t = await testContext().with(config).routes(routes).build();
    contexts.push(t);
    await t.startAndWaitReady();
    return t;
  }

  /**
   * @case Two applications in one process each hold their own surfaces
   * @preconditions Two applications built from one config, so one surfaces plugin descriptor serves both; a surface published into the first only
   * @expectedResult The two states are distinct objects. An exchange of the first finds the surface; the same header on an exchange of the second does not, and a call from it is told the connection is gone rather than reaching the first application's editor
   */
  test("two applications do not see each other's surfaces", async () => {
    const config = surfacing();
    const first = await application(config);
    const second = await application(config);
    expect(surfacesOf(first)).not.toBe(surfacesOf(second));

    let asked = 0;
    registerSurface(
      surfacesOf(first),
      SURFACE_CONNECTION,
      scriptedSurface({
        request: async () => {
          asked += 1;
          return { content: "here" };
        },
      }),
    );

    expect(
      hasSurface(
        new DefaultExchange(first.ctx, { body: {}, headers: SURFACED }),
      ),
    ).toBe(true);
    const foreign = new DefaultExchange(second.ctx, {
      body: {},
      headers: SURFACED,
    });
    expect(hasSurface(foreign)).toBe(false);
    let caught: unknown;
    try {
      await Promise.resolve(
        surface("fs/read_text_file", { path: "/a.ts" }).fetch(foreign),
      );
    } catch (err: unknown) {
      caught = err;
    }
    expect(rcCodeOf(caught)).toBe("AI1014");
    expect(asked).toBe(0);
    expect(surfacesOf(second).surfaces.size).toBe(0);
  });

  /**
   * @case An application with no surface backend has no surfaces, whatever an exchange claims
   * @preconditions No surfaces plugin installed; an exchange carrying a surface header
   * @expectedResult The port is absent, hasSurface answers false and a call is AI1013, which is what the absent store key answered before the port existed
   */
  test("no provider reads as no surface", async () => {
    const t = await application({}, [keepAlive]);
    expect(t.ctx.lookup(SURFACES)).toBeUndefined();
    const exchange = new DefaultExchange(t.ctx, {
      body: {},
      headers: SURFACED,
    });
    expect(hasSurface(exchange)).toBe(false);
    let caught: unknown;
    try {
      await Promise.resolve(
        surface("fs/read_text_file", { path: "/a.ts" }).fetch(exchange),
      );
    } catch (err: unknown) {
      caught = err;
    }
    expect(rcCodeOf(caught)).toBe("AI1013");
    const withdraw = registerCleanup(
      exchange,
      REF,
      scriptedSurface({ request: async () => ({}) }),
      [{ method: "terminal/release", params: { terminalId: "t-1" } }],
    );
    expect(() => withdraw()).not.toThrow();
  });

  /**
   * @case The ACP mount brings the surfaces provider along and publishes its connections into it
   * @preconditions An application listing agentPlugin() and acpPlugin() and nothing else that provides surfaces; an editor connecting
   * @expectedResult The application holds SURFACES, so the mount's requirement resolved without the application naming the provider, and the connected editor is a surface in that state until it disconnects
   */
  test("the ACP mount brings the provider along", async () => {
    h = await acpHarness({ agents: AGENTS });
    const surfaces = h.t.ctx.require(SURFACES);
    const live = await h.connect(async () => {
      await until(() => surfaces.surfaces.size === 1);
      return surfaces.surfaces.size;
    });
    expect(live).toBe(1);
    await until(() => surfaces.surfaces.size === 0);
  });

  /**
   * @case An application that lists the surfaces plugin itself beside the ACP mount gets one provider
   * @preconditions surfacesPlugin() listed explicitly ahead of acpPlugin(), which also brings it along
   * @expectedResult The application builds, so the two did not collide on the plugin id or on the port, and one state serves both
   */
  test("listing the provider beside the mount installs it once", async () => {
    h = await acpHarness({ agents: AGENTS, plugins: [surfacesPlugin()] });
    expect(h.t.ctx.require(SURFACES)).toBeDefined();
  });

  /**
   * @case Cancelling a turn that never reached the surface leaves no signal behind
   * @preconditions A turn cancelled before any route of it asked for its signal
   * @expectedResult No signal is held for it, so the map stays bounded by live work; a route of that turn arriving later is still handed a signal born aborted, because the turn is remembered as cancelled
   */
  test("a cancel mints no signal for a turn that has none", async () => {
    const t = await application();
    const state = surfacesOf(t);
    cancelSurfaceTurn(state, "s", "turn-a");
    expect(state.signals.has("turn-a")).toBe(false);
    expect(turnSignalOf(state, "s", "turn-a").aborted).toBe(true);
  });

  /**
   * @case The lifecycle is released with the plugin that provides it
   * @preconditions A cancel whose cleanup waits on the turn's own exchange, and the application stopping before that exchange reports an end
   * @expectedResult The waiting cleanup is dropped at stop, and an exchange end emitted afterwards reaches no listener, so nothing is sent to the editor after the application let go of it
   */
  test("stopping releases the lifecycle and what it was waiting on", async () => {
    const t = await testContext().with(surfacing()).routes([keepAlive]).build();
    await t.startAndWaitReady();
    const state = surfacesOf(t);
    const sent: string[] = [];
    const connection = scriptedSurface({
      request: async (method) => {
        sent.push(method);
        return {};
      },
    });
    registerSurface(state, SURFACE_CONNECTION, connection);
    const exchange = new DefaultExchange(t.ctx, {
      body: {},
      headers: { ...SURFACED, [HeadersKeys.CORRELATION_ID]: "turn-a" },
    });
    registerCleanup(exchange, REF, connection, [
      { method: "terminal/release", params: { terminalId: "t-1" } },
    ]);
    cancelSurfaceTurn(state, "s", "turn-a", "turn-exchange");
    expect(state.pendingCancels.size).toBe(1);

    await t.stop();

    expect(state.pendingCancels.size).toBe(0);
    t.ctx.emit(
      "route:exchange:completed" as never,
      {
        routeId: "r",
        exchangeId: "turn-exchange",
        correlationId: "c",
      } as never,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toEqual([]);
  });
});
