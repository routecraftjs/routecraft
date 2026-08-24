import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testContext, signHs256, type TestContext } from "@routecraft/testing";
import {
  craft,
  cron,
  direct,
  jwt,
  noop,
  opsPlugin,
} from "@routecraft/routecraft";

const { execCommand, bodyFromArgs, EXEC_EXIT } = await import("../src/exec");
const { routesCommand, routeCommand, healthCommand } =
  await import("../src/ops");

/**
 * `craft exec` and the `craft ops` family, driven against a real instance
 * rather than a stubbed client.
 *
 * The point of these commands is what an operator sees when something is
 * refused, so the cases that matter are the ones where the instance says no:
 * a stubbed transport would happily return whatever shape the test author
 * imagined the server sends.
 */

const SECRET = "cli-exec-test-secret-please-change-me";
const ISSUER = "https://idp.test";
const AUDIENCE = "https://api.test";

/**
 * A bearer carrying exactly the scopes named. The helper's default issuer
 * and audience are the ones the validator below is configured with, so the
 * token verifies without restating them.
 */
function token(scopes: string): string {
  return signHs256({ secret: SECRET, claims: { scope: scopes } });
}

/**
 * An empty working directory and a bare environment, pinned into every
 * command below. Without it a developer's own `.routecraft/settings.yaml`
 * or `CRAFT_TOKEN` would supply a credential to the cases whose entire
 * point is that none was presented, and those cases would pass for the
 * wrong reason on one machine and fail on another.
 */
let cwd: string;
const isolated = (): { cwd: string; env: NodeJS.ProcessEnv } => ({
  cwd,
  env: {},
});
let context: TestContext | undefined;
let url: string;

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), "craft-exec-"));
});

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

afterEach(async () => {
  if (context) await context.stop();
  context = undefined;
});

/** Start an instance carrying the ops surface and resolve its base URL. */
async function start(tiers: Record<string, boolean | string>): Promise<void> {
  const builder = testContext()
    .with({
      servers: { default: { port: 0, host: "127.0.0.1" } },
      plugins: [
        opsPlugin({
          auth: jwt({ secret: SECRET, issuer: ISSUER, audience: AUDIENCE }),
          tiers,
        }),
      ],
    })
    .routes([
      craft()
        .id("greet")
        .title("Greeter")
        .from(direct())
        .transform((body) => `hello ${String((body as { name: string }).name)}`)
        .to(noop()),
      craft().id("nightly").from(cron("0 0 * * *")).to(noop()),
    ]);

  context = await builder.build();
  let port: number | undefined;
  context.ctx.on("server:listening", ({ details }) => {
    port = details.port;
  });
  await context.startAndWaitReady();
  if (port === undefined) throw new Error("no server reported a port");
  url = `http://127.0.0.1:${String(port)}`;
}

describe("craft exec", () => {
  /**
   * @case Trailing flags become a flat request body
   * @preconditions A mix of --key=value, --key value, a bare flag and a repeated key
   * @expectedResult Strings stay strings, a bare flag is true, and a repeat becomes an array. Nothing is coerced to a number, because a CLI guessing types produces bugs that only appear for values that happen to look numeric
   */
  test("builds a body from trailing flags", () => {
    const { body, error } = bodyFromArgs([
      "--name=world",
      "--count",
      "3",
      "--loud",
      "--tag=a",
      "--tag=b",
    ]);
    expect(error).toBeUndefined();
    expect(body).toEqual({
      name: "world",
      count: "3",
      loud: true,
      tag: ["a", "b"],
    });
  });

  /**
   * @case A positional argument where a field was expected is refused
   * @preconditions A trailing argument that is not a --flag
   * @expectedResult An error naming both ways to pass input, rather than a body that silently dropped it
   */
  test("refuses a stray positional argument", () => {
    const { error } = bodyFromArgs(["world"]);
    expect(error).toMatch(/--field=value/);
  });

  /**
   * @case A dispatch on an open tier returns the route's output
   * @preconditions Dispatch tier open, no credential presented
   * @expectedResult Exit 0 and the route's own output
   */
  test("dispatches and prints the result", async () => {
    await start({ dispatch: true });
    const result = await execCommand("greet", ["--name=world"], {
      url,
      ...isolated(),
    });
    expect(result.code).toBe(EXEC_EXIT.ok);
    expect(result.output).toBe("hello world");
  });

  /**
   * @case A credential-free dispatch against a scope-gated tier is refused with the remedy
   * @preconditions Dispatch gated on a scope, no token given
   * @expectedResult Exit 4 and a message naming where a token can be put, so the reader's next action is in the error
   */
  test("refuses a credential-free dispatch and names the remedy", async () => {
    await start({ dispatch: "ops:dispatch" });
    const result = await execCommand("greet", ["--name=world"], {
      url,
      ...isolated(),
    });
    expect(result.code).toBe(EXEC_EXIT.refused);
    expect(result.error).toMatch(/--token/);
  });

  /**
   * @case A token holding only introspection is refused a dispatch, faithfully
   * @preconditions Both tiers scope-gated, a token carrying introspection only
   * @expectedResult Exit 4, and the rendered refusal names the missing scope and says the identity is fine. Swallowing the server's distinction would send the operator to re-authenticate when they need a different credential
   */
  test("renders a tier refusal faithfully", async () => {
    await start({
      introspection: "ops:introspection",
      dispatch: "ops:dispatch",
    });
    const result = await execCommand("greet", ["--name=world"], {
      url,
      token: token("ops:introspection"),
      ...isolated(),
    });
    expect(result.code).toBe(EXEC_EXIT.refused);
    expect(result.error).toMatch(/ops:dispatch/);
    expect(result.error).toMatch(/identity is valid/);
  });

  /**
   * @case A dispatch against a route with no door is a usage error, not a route failure
   * @preconditions Dispatch open, target route sourced from cron()
   * @expectedResult Exit 2 with the reason. Nothing ran, so reporting it as a route failure would send a script's error path after an exchange that never existed
   */
  test("reports a non-dispatchable route as a usage error", async () => {
    await start({ dispatch: true });
    const result = await execCommand("nightly", [], { url, ...isolated() });
    expect(result.code).toBe(EXEC_EXIT.usage);
    expect(result.error).toMatch(/no dispatch door/);
  });

  /**
   * @case An instance that cannot be reached names the address and its source
   * @preconditions A url flag pointing at a port nothing is listening on
   * @expectedResult Exit 3, with both the address and where it came from, so a wrong pinned address is diagnosable from the message alone
   */
  test("names the effective address and its source when unreachable", async () => {
    const result = await execCommand("greet", [], {
      url: "http://127.0.0.1:9",
      ...isolated(),
    });
    expect(result.code).toBe(EXEC_EXIT.unreachable);
    expect(result.error).toMatch(/127\.0\.0\.1:9/);
    expect(result.error).toMatch(/from the flag/);
  });

  /**
   * @case Input given twice is refused rather than silently resolved
   * @preconditions Both piped stdin and trailing --field arguments
   * @expectedResult Exit 2. Picking a winner silently would make the losing input invisible
   */
  test("refuses input given on both stdin and flags", async () => {
    await start({ dispatch: true });
    const result = await execCommand("greet", ["--name=flag"], {
      url,
      stdin: '{"name":"piped"}',
      ...isolated(),
    });
    expect(result.code).toBe(EXEC_EXIT.usage);
    expect(result.error).toMatch(/one or the other/);
  });

  /**
   * @case Introspection with no route named lists what can be dispatched to
   * @preconditions Introspection open, exec called with no route
   * @expectedResult Exit 0, static help plus only the dispatchable route. The cron route cannot be exec'd, so listing it would be an invitation to an error
   */
  test("lists dispatchable endpoints when no route is named", async () => {
    await start({ introspection: true });
    const result = await execCommand(undefined, [], { url, ...isolated() });
    expect(result.code).toBe(EXEC_EXIT.ok);
    expect(result.output).toMatch(/greet/);
    expect(result.output).not.toMatch(/nightly/);
  });

  /**
   * @case Introspection refused shows static help plus the real refusal
   * @preconditions Introspection gated on a scope, no credential presented
   * @expectedResult Exit 4, the usage text still printed, and the refusal on the error stream. Never an empty endpoint list, which would read as "this instance exposes nothing"
   */
  test("shows static help and the real refusal when introspection is refused", async () => {
    await start({ introspection: "ops:introspection" });
    const result = await execCommand(undefined, [], { url, ...isolated() });
    expect(result.code).toBe(EXEC_EXIT.refused);
    expect(result.output).toMatch(/Usage: craft exec/);
    expect(result.error).toMatch(/introspection was refused/);
  });
});

describe("craft ops", () => {
  /**
   * @case The route listing follows the cursor rather than stopping at page one
   * @preconditions More routes than a single default page, introspection open
   * @expectedResult Every route appears. A client that reads page one and stops reports a partial inventory as a complete one
   */
  test("follows the cursor across every page", async () => {
    const routes = Array.from({ length: 120 }, (_unused, index) =>
      craft()
        .id(`route-${String(index).padStart(3, "0")}`)
        .from(direct())
        .to(noop()),
    );
    context = await testContext()
      .with({
        servers: { default: { port: 0, host: "127.0.0.1" } },
        plugins: [opsPlugin({ tiers: { introspection: true } })],
      })
      .routes(routes)
      .build();
    let port: number | undefined;
    context.ctx.on("server:listening", ({ details }) => {
      port = details.port;
    });
    await context.startAndWaitReady();

    const result = await routesCommand({
      url: `http://127.0.0.1:${String(port)}`,
      format: "raw",
      ...isolated(),
    });
    expect(result.code).toBe(EXEC_EXIT.ok);
    expect(result.output?.split("\n")).toHaveLength(120);
  });

  /**
   * @case One route reads thinner without a credential and fuller with one
   * @preconditions The same instance queried twice, once anonymously and once with a token
   * @expectedResult The authenticated view carries the route definition and the component details; the anonymous one visibly does not, and says which view it is rather than rendering a status with no reason
   */
  test("degrades visibly without a credential and fills in with one", async () => {
    await start({ introspection: "ops:introspection" });

    const anonymous = await routeCommand("greet", { url, ...isolated() });
    expect(anonymous.code).toBe(EXEC_EXIT.ok);
    expect(anonymous.output).toMatch(/Anonymous view/);
    expect(anonymous.output).not.toMatch(/Greeter/);

    const authenticated = await routeCommand("greet", {
      url,
      token: token("ops:introspection"),
      ...isolated(),
    });
    expect(authenticated.code).toBe(EXEC_EXIT.ok);
    expect(authenticated.output).toMatch(/Authenticated view/);
    expect(authenticated.output).toMatch(/Greeter/);
  });

  /**
   * @case Health answers without a credential, because it never walls
   * @preconditions Every management tier scope-gated, no credential presented
   * @expectedResult Exit 0 with the report. Health and the management tiers have opposite postures on one mount, and gating the tiers must not take the orchestrator's probe with them
   */
  test("reads health with no credential even while ops is walled", async () => {
    await start({
      introspection: "ops:introspection",
      dispatch: "ops:dispatch",
    });
    const result = await healthCommand({ url, format: "raw", ...isolated() });
    expect(result.code).toBe(EXEC_EXIT.ok);
    expect(result.output).toBe("up");
  });
});
