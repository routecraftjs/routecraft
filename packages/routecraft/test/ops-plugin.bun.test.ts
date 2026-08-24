import { afterEach, describe, expect, test } from "bun:test";
import { signHs256, testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  defineIndicator,
  direct,
  jwt,
  noop,
  opsPlugin,
  simple,
  type HealthReport,
  type Indicator,
  type OpsPluginOptions,
} from "../src/index.ts";

const JWT_SECRET = "ops-test-secret-please-change-me";
const JWT_ISSUER = "https://idp.test";
const JWT_AUDIENCE = "https://api.test";

/** Whatever the test harness accepts as a route list. */
type Routes = Parameters<ReturnType<typeof testContext>["routes"]>[0];

interface Fetched {
  status: number;
  body: HealthReport & Record<string, unknown>;
}

async function get(
  port: number,
  path: string,
  token?: string,
): Promise<Fetched> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: (await res.json()) as Fetched["body"] };
}

/** A valid HS256 token for the server-level validator. */
function makeJwt(): string {
  return signHs256({ secret: JWT_SECRET });
}

/** Capture warn-level messages on a context's logger for the test's lifetime. */
function captureWarnings(ctx: TestContext["ctx"]): string[] {
  const warnings: string[] = [];
  const original = ctx.logger.warn.bind(ctx.logger);
  ctx.logger.warn = ((first: unknown, second?: unknown) => {
    warnings.push(typeof first === "string" ? first : String(second));
    return original(first as never, second as never);
  }) as typeof ctx.logger.warn;
  return warnings;
}

/**
 * The ops plugin end to end: the endpoints an orchestrator and an uptime
 * monitor actually call.
 *
 * The three signals are separated by what acting on each one does, so the
 * cases that matter most are the ones pinning that a dependency failure can
 * never reach liveness, that a deployment-wide failure can never reach
 * readiness, and that a failing exchange reaches neither.
 */
describe("the ops plugin", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * Start a context carrying the ops mount and return the port its server
   * bound. Port 0 asks the OS for a free one, so the tests never collide with
   * whatever else is running; the resolved port arrives on `server:listening`,
   * which is also the event an operator would use.
   */
  async function start(
    options: OpsPluginOptions = {},
    routes?: Routes,
    serverAuth = false,
  ): Promise<number> {
    const builder = testContext()
      .with({
        servers: {
          default: {
            port: 0,
            host: "127.0.0.1",
            ...(serverAuth
              ? {
                  auth: jwt({
                    secret: JWT_SECRET,
                    issuer: JWT_ISSUER,
                    audience: JWT_AUDIENCE,
                  }),
                }
              : {}),
          },
        },
        plugins: [opsPlugin(options)],
      })
      .routes(routes ?? [craft().id("worker").from(direct()).to(noop())]);

    t = await builder.build();
    let port: number | undefined;
    t.ctx.on("server:listening", ({ details }) => {
      port = details.port;
    });
    await t.startAndWaitReady();
    if (port === undefined) throw new Error("no server reported a port");
    return port;
  }

  /**
   * @case A healthy app answers 200 on all three signals with no health code
   * @preconditions A started context with one running route and no indicators
   * @expectedResult Aggregate, liveness and readiness all answer 200, and the aggregate lists the route as up. Route lifecycle and the serving state are derived from events the framework already emits, so an app writes nothing to get a truthful surface
   */
  test("serves all three signals with no application health code", async () => {
    const port = await start();

    const health = await get(port, "/health");
    expect(health.status).toBe(200);
    expect(health.body.status).toBe("up");
    expect(health.body.view).toBe("all");
    expect(health.body.context).toMatchObject({
      status: "up",
      domain: "instance",
    });
    expect(health.body.routes["worker"]).toMatchObject({ status: "up" });

    const live = await get(port, "/health/live");
    expect(live.status).toBe(200);
    expect(live.body["status"]).toBe("up");
    expect(typeof live.body["uptime"]).toBe("number");

    const ready = await get(port, "/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body.view).toBe("readiness");
  });

  /**
   * @case A failing exchange never takes the aggregate down
   * @preconditions A route with no error handler whose processor throws, so the framework emits context:error alongside route:exchange:failed
   * @expectedResult The aggregate stays 200 and the route stays up, carrying the failure as diagnostic detail. This is the rule the whole surface is built on: a refused caller or a validation error is a healthy route behaving correctly, and escalating it turns every scope gap into an incident
   */
  test("keeps a failing exchange out of the health verdict", async () => {
    const port = await start({ health: { details: "always" } }, [
      craft()
        .id("thrower")
        .from(simple("tick"))
        .process(() => {
          throw new Error("caller asked for something they may not have");
        })
        .to(noop()),
      craft().id("worker").from(direct()).to(noop()),
    ]);

    await t?.drain();

    const health = await get(port, "/health");
    // `inactive`, not `up`: the route is a finished one-shot, which is why
    // the assertion below is negative.
    expect(health.status).toBe(200);
    expect(health.body.status).toBe("up");
    expect(health.body.routes["thrower"]?.status).not.toBe("down");
    expect(health.body.routes["thrower"]?.details).toMatchObject({
      failures: 1,
    });
  });

  /**
   * @case Liveness never carries component state
   * @preconditions An indicator reported down, so the aggregate is 503
   * @expectedResult Liveness still answers 200 and its body carries only status and uptime. Restarting cannot fix someone else's outage, so a dependency reaching liveness would restart every replica in a loop
   */
  test("keeps every component out of liveness", async () => {
    const dependency = defineIndicator({ name: "mail" });
    const port = await start({ indicators: [dependency] });

    dependency.down();

    expect((await get(port, "/health")).status).toBe(503);
    const live = await get(port, "/health/live");
    expect(live.status).toBe(200);
    expect(Object.keys(live.body).sort()).toEqual(["status", "uptime"]);
  });

  /**
   * @case A deployment-domain failure pages without moving traffic
   * @preconditions An indicator on the default domain, reported down with details
   * @expectedResult The aggregate is 503 while readiness stays 200 and omits the component. A shared failure is identical on every replica, so derotating one only moves traffic to a peer that fails the same way
   */
  test("pages on a deployment failure without failing readiness", async () => {
    const dependency = defineIndicator({ name: "mail" });
    const port = await start({
      health: { details: "always" },
      indicators: [dependency],
    });

    dependency.down({ subsystem: "imap" });

    const health = await get(port, "/health");
    expect(health.status).toBe(503);
    expect(health.body.indicators["mail"]).toMatchObject({
      status: "down",
      domain: "deployment",
      details: { subsystem: "imap" },
    });

    const ready = await get(port, "/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body.indicators["mail"]).toBeUndefined();
  });

  /**
   * @case An instance-domain failure does refuse traffic
   * @preconditions An indicator declaring the instance domain, reported down
   * @expectedResult Readiness answers 503, because moving traffic to a peer genuinely helps when the failure is local to this replica
   */
  test("fails readiness on an instance-domain failure", async () => {
    const disk = defineIndicator({ name: "disk", domain: "instance" });
    const port = await start({ indicators: [disk] });

    disk.down();

    expect((await get(port, "/health/ready")).status).toBe(503);
  });

  /**
   * @case A route-bound indicator follows a successful probe
   * @preconditions An indicator bound to a probe route that runs one successful exchange
   * @expectedResult The indicator reports up with no health code in the route. For a probe the exchange is the health check by construction
   */
  test("reports a bound indicator up when its probe succeeds", async () => {
    const probe = defineIndicator({ name: "mail", route: "probe" });
    const port = await start({ indicators: [probe] }, [
      craft().id("probe").from(simple("tick")).to(noop()),
      // A long-running route so the context does not finish the moment the
      // one-shot probe completes.
      craft().id("worker").from(direct()).to(noop()),
    ]);

    await t?.drain();

    const health = await get(port, "/health");
    expect(health.body.indicators["mail"]).toMatchObject({ status: "up" });
    expect(health.status).toBe(200);
  });

  /**
   * @case A route-bound indicator follows a failing probe
   * @preconditions An indicator bound to a probe route whose processor throws
   * @expectedResult The indicator reports down and the aggregate is 503, again with no health code in the route. A probe's exchange failing is the dependency check failing, which is the one case where an exchange outcome is the health signal
   */
  test("reports a bound indicator down when its probe fails", async () => {
    const probe = defineIndicator({ name: "mail", route: "probe" });
    const port = await start({ indicators: [probe] }, [
      craft()
        .id("probe")
        .from(simple("tick"))
        .process(() => {
          throw new Error("imap unreachable");
        })
        .to(noop()),
      craft().id("worker").from(direct()).to(noop()),
    ]);

    await t?.drain();

    const health = await get(port, "/health");
    expect(health.body.indicators["mail"]).toMatchObject({ status: "down" });
    expect(health.status).toBe(503);
  });

  /**
   * @case An indicator bound to a route nobody declared fails the boot
   * @preconditions An indicator naming a route id no route uses
   * @expectedResult Context start refuses with RC5053. A typo would otherwise present as a dependency stuck reporting nothing, which is indistinguishable from a probe that never runs
   */
  test("refuses to start when a bound route does not exist", async () => {
    const probe = defineIndicator({ name: "mail", route: "typo" });
    t = await testContext()
      .with({
        servers: { default: { port: 0, host: "127.0.0.1" } },
        plugins: [opsPlugin({ indicators: [probe] })],
      })
      .routes([craft().id("worker").from(direct()).to(noop())])
      .build();

    // Assert on ctx.start(): that is the promise the failure propagates
    // through, and awaiting only the readiness side would leave the run
    // promise rejecting unobserved.
    await expect(t.ctx.start()).rejects.toThrow(/RC5053|typo/);
  });

  /**
   * @case Two indicators sharing a name fail the build
   * @preconditions Two handles declaring the same name in ops.indicators
   * @expectedResult Building the context throws RC5053. Names are the keys of the health report, so a duplicate would silently shadow one dependency with another
   */
  test("refuses duplicate indicator names", async () => {
    const first = defineIndicator({ name: "mail" });
    const second = defineIndicator({ name: "mail" });

    await expect(
      testContext()
        .with({
          servers: { default: { port: 0, host: "127.0.0.1" } },
          plugins: [opsPlugin({ indicators: [first, second] })],
        })
        .routes([craft().id("worker").from(direct()).to(noop())])
        .build(),
    ).rejects.toThrow(/RC5053|Duplicate indicator/);
  });

  /**
   * @case A hand-rolled object shaped like an indicator is refused
   * @preconditions An object literal satisfying the Indicator type but not produced by defineIndicator
   * @expectedResult Building the context throws RC5053 rather than failing later on a missing binding. The type is structural, so the runtime has to be what says no
   */
  test("refuses an indicator defineIndicator did not produce", async () => {
    const impostor: Indicator = {
      name: "fake",
      definition: { name: "fake" },
      up() {},
      down() {},
      inactive() {},
    };

    await expect(
      testContext()
        .with({
          servers: { default: { port: 0, host: "127.0.0.1" } },
          plugins: [opsPlugin({ indicators: [impostor] })],
        })
        .routes([craft().id("worker").from(direct()).to(noop())])
        .build(),
    ).rejects.toThrow(/RC5053|defineIndicator/);
  });

  /**
   * @case Pushing through an unbound handle is inert, not fatal
   * @preconditions A handle never registered with any context
   * @expectedResult The push returns without throwing. Health instrumentation must not be able to kill the code it instruments: an exchange draining after teardown released the binding would otherwise carry an error out of its handler and into the route
   */
  test("makes a push through an unbound handle inert", () => {
    const orphan = defineIndicator({ name: "orphan" });

    expect(() => orphan.up()).not.toThrow();
    expect(() => orphan.down({ reason: "unbound" })).not.toThrow();
    expect(() => orphan.inactive()).not.toThrow();
  });

  /**
   * @case Per-component paths answer with their own status code
   * @preconditions A running route and a down indicator
   * @expectedResult The route path answers 200, the indicator path 503, and unknown names 404 on both prefixes. A targeted monitor watches one component without parsing the aggregate
   */
  test("serves single components with their own status code", async () => {
    const dependency = defineIndicator({ name: "mail" });
    const port = await start({ indicators: [dependency] });
    dependency.down();

    expect((await get(port, "/health/routes/worker")).status).toBe(200);
    expect((await get(port, "/health/indicators/mail")).status).toBe(503);
    expect((await get(port, "/health/routes/nope")).status).toBe(404);
    expect((await get(port, "/health/indicators/nope")).status).toBe(404);
  });

  /**
   * @case A malformed percent-escape is a 404, not a crash
   * @preconditions A component path containing an invalid escape sequence
   * @expectedResult 404. Decoding throws on input any caller can send, and a surface that admits unauthenticated callers must never be able to take the process down
   */
  test("answers 404 for a malformed component path", async () => {
    const port = await start();

    const res = await fetch(`http://127.0.0.1:${port}/health/routes/%zz`);
    expect(res.status).toBe(404);
  });

  /**
   * @case A component id is exactly one path segment
   * @preconditions A component path carrying an extra unencoded segment
   * @expectedResult 404. The documented shape is one segment, so an id containing a slash is reachable only percent-encoded and a deeper path is simply unknown
   */
  test("does not match a component path with extra segments", async () => {
    const port = await start();

    expect((await get(port, "/health/routes/mail-intake/extra")).status).toBe(
      404,
    );
    expect((await get(port, "/health/indicators/mail/extra")).status).toBe(404);
  });

  /**
   * @case A down component named __proto__ still reaches the report and the aggregate
   * @preconditions An indicator whose name is the prototype key, pushed down
   * @expectedResult The component is listed and the aggregate goes 503. Assigning that key on a plain object silently discards the entry, which would drop a down component out of the body and out of aggregation, so /health would read healthy while it was not
   */
  test("reports a down component named __proto__", async () => {
    const proto = defineIndicator({ name: "__proto__" });
    const port = await start({ indicators: [proto] });

    expect((await get(port, "/health")).status).toBe(200);

    proto.down();

    const health = await get(port, "/health");
    expect(Object.keys(health.body.indicators)).toContain("__proto__");
    expect(health.body.indicators["__proto__"]).toMatchObject({
      status: "down",
    });
    // The aggregate is the part a dropped key would silently break.
    expect(health.body.status).toBe("down");
    expect(health.status).toBe(503);
  });

  /**
   * @case Ops supersedes the http /health built-in on a shared server
   * @preconditions Both plugins in their minimal documented form on one server
   * @expectedResult The context starts and /health is the real report, not the constant. Refusing the most natural pair of config keys would be a worse answer than letting the superset win, and the http built-in is a constant that can never go red
   */
  test("supersedes the http /health built-in on a shared server", async () => {
    const builder = testContext()
      .with({
        servers: { default: { port: 0, host: "127.0.0.1" } },
        http: {},
        plugins: [opsPlugin()],
      })
      .routes([craft().id("worker").from(direct()).to(noop())]);

    t = await builder.build();
    let port: number | undefined;
    t.ctx.on("server:listening", ({ details }) => {
      port = details.port;
    });
    await t.startAndWaitReady();
    if (port === undefined) throw new Error("no server reported a port");

    // The constant built-in answers `{ status: "ok" }` and nothing else; the
    // ops report carries components, so the body distinguishes them.
    const health = await get(port, "/health");
    expect(health.status).toBe(200);
    expect(health.body.view).toBe("all");
    expect(health.body.routes["worker"]).toMatchObject({ status: "up" });

    // /ready is not under an ops claim, so the http built-in still owns it.
    expect((await get(port, "/ready")).status).toBe(200);
  });

  /**
   * @case An indicator name that is not a single path segment is refused
   * @preconditions defineIndicator called with a name containing a slash and one containing a space
   * @expectedResult Both throw at declaration. The name is the last segment of /health/indicators/<name>, so a slash would leave the component unreachable at its own path, presenting as an endpoint that is simply missing
   */
  test("refuses an indicator name that is not one path segment", () => {
    expect(() => defineIndicator({ name: "mail/imap" })).toThrow(
      /single URL path segment/,
    );
    expect(() => defineIndicator({ name: "mail probe" })).toThrow(
      /single URL path segment/,
    );
    expect(() => defineIndicator({ name: "mail-imap_1" })).not.toThrow();
  });

  /**
   * @case Two ops surfaces on one server are refused
   * @preconditions Two opsPlugin instances pointed at the same named server
   * @expectedResult The build is refused. The second apply() would otherwise replace the published ledger and rebind every indicator to it, leaving the handler that is actually mounted reporting from a ledger nothing writes to
   */
  test("refuses a second ops surface on the same server", async () => {
    const builder = testContext()
      .with({
        servers: { default: { port: 0, host: "127.0.0.1" } },
        plugins: [opsPlugin(), opsPlugin()],
      })
      .routes([craft().id("worker").from(direct()).to(noop())]);

    await expect(builder.build()).rejects.toThrow(
      /already carries an ops mount/,
    );
  });

  /**
   * @case Indicator names that URL normalisation would eat are refused
   * @preconditions defineIndicator called with "." and ".."
   * @expectedResult Both throw. They survive encodeURIComponent unchanged but the URL parser removes them, so the component would be unreachable at its own path
   */
  test("refuses dot-segment indicator names", () => {
    expect(() => defineIndicator({ name: "." })).toThrow(
      /single URL path segment/,
    );
    expect(() => defineIndicator({ name: ".." })).toThrow(
      /single URL path segment/,
    );
  });

  /**
   * @case A declared but unregistered indicator is reported at start
   * @preconditions A handle from defineIndicator that is never listed in ops.indicators
   * @expectedResult A warning naming it. Pushing through an unregistered handle is inert by design, so without this the route keeps reporting, the key never appears, and nothing pages: the surface looks instrumented while watching nothing
   */
  test("warns about a declared indicator nobody registered", async () => {
    const orphan = defineIndicator({ name: `orphan-${Date.now()}` });

    const builder = testContext()
      .with({
        servers: { default: { port: 0, host: "127.0.0.1" } },
        plugins: [opsPlugin()],
      })
      .routes([craft().id("worker").from(direct()).to(noop())]);

    t = await builder.build();
    const warnings = captureWarnings(t.ctx);

    await t.startAndWaitReady();

    expect(warnings.some((w) => w.includes(orphan.name))).toBe(true);
  });

  /**
   * @case The reserved action namespace answers 404
   * @preconditions A request to /ops
   * @expectedResult 404. The namespace is claimed so no other surface can take it, but ships nothing: every action there mutates and will require an authenticated principal
   */
  test("serves nothing on the reserved action namespace", async () => {
    const port = await start();

    expect((await get(port, "/ops/routes")).status).toBe(404);
  });

  /**
   * @case Writes to the health surface are refused
   * @preconditions A POST to the aggregate
   * @expectedResult 405 advertising the two read methods. The read surface is read-only by contract, which is what lets it admit unauthenticated callers
   */
  test("refuses non-read methods", async () => {
    const port = await start();

    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      method: "POST",
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD");
  });

  /**
   * @case details: never withholds diagnostics but still serves statuses
   * @preconditions A down indicator carrying details, exposure set to never
   * @expectedResult Statuses and component names are served, details are absent. The gate withholds per-component diagnostics; it does not hide topology, because names are the keys of the always-served maps
   */
  test("withholds details without withholding statuses", async () => {
    const dependency = defineIndicator({ name: "mail" });
    const port = await start({
      health: { details: "never" },
      indicators: [dependency],
    });
    dependency.down({ subsystem: "imap" });

    const health = await get(port, "/health");
    expect(health.status).toBe(503);
    expect(health.body.indicators["mail"]?.details).toBeUndefined();
    expect(health.body.indicators["mail"]?.status).toBe("down");
    expect(health.body.context.details).toBeUndefined();
    expect(health.body.routes["worker"]?.details).toBeUndefined();
    expect(health.body.routes["worker"]?.status).toBe("up");
  });

  /**
   * @case The defaulted details gate collapses to never when no validator exists
   * @preconditions The unwritten default exposure on a server with no auth configured and no ops.auth
   * @expectedResult Statuses are served, details are withheld from every caller, and a startup warning names the ways out. A default must not leak app-supplied diagnostics to an anonymous caller; a missing diagnostic is visible, a leak is silent
   */
  test("collapses the defaulted details gate to never when no validator exists", async () => {
    const builder = testContext()
      .with({
        servers: { default: { port: 0, host: "127.0.0.1" } },
        plugins: [opsPlugin()],
      })
      .routes([craft().id("worker").from(direct()).to(noop())]);
    t = await builder.build();
    let port: number | undefined;
    t.ctx.on("server:listening", ({ details }) => {
      port = details.port;
    });
    const warnings = captureWarnings(t.ctx);
    await t.startAndWaitReady();
    if (port === undefined) throw new Error("no server reported a port");

    const health = await get(port, "/health");
    expect(health.status).toBe(200);
    expect(health.body.routes["worker"]?.status).toBe("up");
    expect(health.body.routes["worker"]?.details).toBeUndefined();
    expect(warnings.some((w) => w.includes("statuses only"))).toBe(true);
  });

  /**
   * @case An explicit when-authenticated gate with no validator fails the boot
   * @preconditions health.details written as "when-authenticated", no ops.auth, no server validator
   * @expectedResult RC5053 at apply. The operator asked for a gate and there is nothing to gate with; reinterpreting that in either direction is guessing at intent
   */
  test("refuses an explicit when-authenticated gate with no validator", async () => {
    const builder = testContext()
      .with({
        servers: { default: { port: 0, host: "127.0.0.1" } },
        plugins: [opsPlugin({ health: { details: "when-authenticated" } })],
      })
      .routes([craft().id("worker").from(direct()).to(noop())]);
    await expect(builder.build()).rejects.toThrow(/no validator is in scope/);
  });

  /**
   * @case ops.auth: false is accepted and means no effective validator
   * @preconditions auth: false on a server that does carry a validator, health.details: "always"
   * @expectedResult The boot succeeds and health still answers. `false` carries the server plugin's meaning unchanged (opt out of the inherited validator) rather than being refused as a no-op, which is what lets one vocabulary describe every mount
   */
  test("accepts ops.auth false as an opt-out from the inherited validator", async () => {
    const port = await start(
      { auth: false, health: { details: "always" } },
      undefined,
      true,
    );
    const { status } = await get(port, "/health");
    expect(status).toBe(200);
  });

  /**
   * @case A scope-gated tier with no validator in scope fails the boot
   * @preconditions ops.tiers.introspection set to a scope string, no ops.auth and no server validator
   * @expectedResult RC5053 at apply. A scope with nothing to verify it against can only be resolved by admitting everyone or refusing everyone, and neither is what the operator wrote
   */
  test("refuses a scope-gated tier with no validator in scope", async () => {
    const builder = testContext()
      .with({
        servers: { default: { port: 0, host: "127.0.0.1" } },
        plugins: [opsPlugin({ tiers: { introspection: "ops:introspection" } })],
      })
      .routes([craft().id("worker").from(direct()).to(noop())]);
    await expect(builder.build()).rejects.toThrow(/no validator is in scope/);
  });

  /**
   * @case An empty scope string is refused rather than enforced
   * @preconditions ops.tiers.dispatch set to ""
   * @expectedResult RC5053 at construction. No principal can carry an empty scope, so enforcing it would refuse every caller while reading like a configured tier
   */
  test("refuses an empty tier scope string", () => {
    expect(() => opsPlugin({ tiers: { dispatch: "" } })).toThrow(
      /empty scope string/,
    );
  });

  /**
   * @case The details gate admits through the inherited server validator
   * @preconditions when-authenticated exposure on a server with a jwt validator, ops.auth unset
   * @expectedResult An anonymous caller gets statuses without details and never a 401; a caller the inherited validator admits gets the details too
   */
  test("gates details on the inherited server validator", async () => {
    const port = await start(
      { health: { details: "when-authenticated" } },
      undefined,
      true,
    );

    const anonymous = await get(port, "/health");
    expect(anonymous.status).toBe(200);
    expect(anonymous.body.routes["worker"]?.status).toBe("up");
    expect(anonymous.body.routes["worker"]?.details).toBeUndefined();

    const admitted = await get(port, "/health", makeJwt());
    expect(admitted.status).toBe(200);
    expect(admitted.body.routes["worker"]?.details).toEqual({
      lifecycle: "running",
    });
  });

  /**
   * @case The details gate admits through the ops mount's own validator
   * @preconditions ops.auth is an api key on a server with no validator of its own
   * @expectedResult The wrong key and no key both get statuses without details and never a 401 (the surface has no wall, so /health/live keeps answering the kubelet); the right key gets details
   */
  test("gates details on the ops mount's own validator", async () => {
    const port = await start({
      auth: {
        kind: "apiKey",
        in: "header",
        name: "x-ops-key",
        keys: ["s3cret"],
      },
      health: { details: "when-authenticated" },
    });

    const anonymous = await get(port, "/health");
    expect(anonymous.status).toBe(200);
    expect(anonymous.body.routes["worker"]?.details).toBeUndefined();

    const live = await get(port, "/health/live");
    expect(live.status).toBe(200);

    const wrongKey = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { "x-ops-key": "wrong" },
    });
    expect(wrongKey.status).toBe(200);
    const wrongBody = (await wrongKey.json()) as Fetched["body"];
    expect(wrongBody.routes["worker"]?.details).toBeUndefined();

    const rightKey = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { "x-ops-key": "s3cret" },
    });
    expect(rightKey.status).toBe(200);
    const rightBody = (await rightKey.json()) as Fetched["body"];
    expect(rightBody.routes["worker"]?.details).toEqual({
      lifecycle: "running",
    });
  });

  /**
   * @case The details gate is real when the server carries a validator
   * @preconditions A server-level JWT validator and the default exposure
   * @expectedResult An anonymous caller gets statuses without details and a valid bearer gets details, while both get 200. The probe still works without a credential, which is what lets an orchestrator use it
   */
  test("serves details only to an admitted caller when a validator exists", async () => {
    const port = await start({}, undefined, true);

    const anonymous = await get(port, "/health");
    expect(anonymous.status).toBe(200);
    expect(anonymous.body.routes["worker"]?.status).toBe("up");
    expect(anonymous.body.routes["worker"]?.details).toBeUndefined();

    const authenticated = await get(port, "/health", makeJwt());
    expect(authenticated.status).toBe(200);
    expect(authenticated.body.routes["worker"]?.details).toEqual({
      lifecycle: "running",
    });
  });

  /**
   * @case Status transitions are observable as events
   * @preconditions A listener on the health-changed event, then an indicator reported down and up again
   * @expectedResult Both transitions are emitted with component, name and both statuses, so an operator alerts on the change rather than polling, and the recovery closes the alert the failure opened
   */
  test("emits a transition when a component changes status", async () => {
    const dependency = defineIndicator({ name: "mail" });
    const port = await start({ indicators: [dependency] });
    const changes: { name: string; from: string; to: string }[] = [];
    t?.ctx.on("plugin:ops:health:changed", ({ details }) => {
      changes.push({ name: details.name, from: details.from, to: details.to });
    });

    dependency.down();
    dependency.up();

    expect(changes).toEqual([
      { name: "mail", from: "up", to: "down" },
      { name: "mail", from: "down", to: "up" },
    ]);
    expect((await get(port, "/health")).status).toBe(200);
  });

  /**
   * @case Invalid options fail at construction
   * @preconditions An unrecognised details mode
   * @expectedResult RC5053 before anything mounts, so a typo cannot reach a live surface
   */
  test("validates its options", () => {
    expect(() =>
      opsPlugin({
        // Deliberately invalid: asserting the runtime guard, which is what
        // protects an app configuring this from JavaScript.
        health: { details: "sometimes" as "always" },
      }),
    ).toThrow(/RC5053|health.details/);
  });

  /**
   * @case An undefined server name fails the build
   * @preconditions The mount pointed at a server no config declares
   * @expectedResult Building throws, naming the defined servers. Mounting is a config-time relationship, so a typo must not wait until a probe arrives
   */
  test("refuses to mount on a server that does not exist", async () => {
    await expect(
      testContext()
        .with({
          servers: { default: { port: 0, host: "127.0.0.1" } },
          plugins: [opsPlugin({ server: "internal" })],
        })
        .routes([craft().id("worker").from(direct()).to(noop())])
        .build(),
    ).rejects.toThrow(/internal/);
  });

  /**
   * @case The mount is released on teardown
   * @preconditions A started context that is then stopped
   * @expectedResult The port stops answering. The listener belongs to the server plugin, but a mount left registered would keep answering for a context that no longer exists
   */
  test("releases its mount on teardown", async () => {
    const port = await start();
    expect((await get(port, "/health")).status).toBe(200);

    await t?.stop();
    t = undefined;

    // The listener belongs to the server plugin and closes gracefully, so the
    // socket may still be reachable for a moment. What this pins is that the
    // health surface is gone: whether the request is refused outright or
    // answered by a server with nothing mounted, it must not still be 200.
    const after = await fetch(`http://127.0.0.1:${port}/health`).catch(
      () => undefined,
    );
    expect(after?.status).not.toBe(200);
  });
});
