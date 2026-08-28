import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SignJWT } from "jose";
import { bootServer, testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  direct,
  jwt,
  noop,
  opsPlugin,
  type CraftConfig,
} from "@routecraft/routecraft";

const { execCommand, EXEC_EXIT } = await import("../src/exec");

/**
 * The credential ladder's automated rungs (#669), each reached end to end
 * through `craft exec` against a real instance: no auth, the documented
 * static-key recipe run VERBATIM from the docs page, and a self-signed JWT
 * minted with jose. The fourth rung (a real AS) is a recorded one-off on
 * the ticket, not a CI case.
 */

/** The docs page the static-key recipe is extracted from, verbatim. */
const SECURING_PAGE = join(
  import.meta.dir,
  "../../../apps/routecraft.dev/app/content/docs/advanced/securing-capabilities/index.mdx",
);

/**
 * Pull the first ts code fence after the static-key rung heading. The test
 * compiles and runs exactly what the page publishes, so a drift between the
 * recipe and the framework fails here instead of on a reader's machine.
 */
function extractStaticKeyRecipe(): string {
  const page = readFileSync(SECURING_PAGE, "utf8");
  const heading = page.indexOf("### Rung 2: a static key");
  if (heading < 0) throw new Error("static-key rung heading not found");
  const fenceOpen = page.indexOf("```ts", heading);
  if (fenceOpen < 0) throw new Error("static-key code fence not found");
  const start = page.indexOf("\n", fenceOpen) + 1;
  const fenceClose = page.indexOf("```", start);
  if (fenceClose < 0) throw new Error("static-key code fence not closed");
  return page.slice(start, fenceClose);
}

/** An empty cwd and env, so a developer's own settings cannot leak in. */
let cwd: string;
const isolated = (): { cwd: string; env: NodeJS.ProcessEnv } => ({
  cwd,
  env: {},
});

let context: TestContext | undefined;

/** Build and start an instance from a config, returning its base URL. */
async function boot(
  config: CraftConfig,
  routes: Parameters<ReturnType<typeof testContext>["routes"]>[0],
): Promise<string> {
  const booted = await bootServer((builder) =>
    builder.with(config).routes(routes),
  );
  context = booted.ctx;
  return `http://127.0.0.1:${String(booted.port)}`;
}

const greet = () =>
  craft()
    .id("greet")
    .from(direct())
    .transform((body) => `hello ${String((body as { name: string }).name)}`)
    .to(noop());

describe("the credential ladder via craft exec", () => {
  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), "craft-ladder-"));
  });

  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  afterEach(async () => {
    if (context) await context.stop();
    context = undefined;
  });

  /**
   * @case Rung 1: no auth end to end
   * @preconditions A server with no validator anywhere, the dispatch tier open, a route with no .authorize(), no credential presented
   * @expectedResult craft exec completes with the route's output and exit 0: nothing configured, works
   */
  test("no auth: an unauthenticated instance dispatches with no flags", async () => {
    const url = await boot(
      {
        servers: { default: { port: 0, host: "127.0.0.1" } },
        plugins: [opsPlugin({ tiers: { dispatch: true } })],
      },
      [greet()],
    );
    const result = await execCommand("greet", ["--name=world"], {
      url,
      ...isolated(),
    });
    expect(result.code).toBe(EXEC_EXIT.ok);
    expect(result.output).toBe("hello world");
  });

  /**
   * @case Rung 2: the published static-key recipe, compiled and run verbatim
   * @preconditions The exact craft.config.ts code fence from the securing-capabilities page, written to disk, imported, and started with only the port pinned to 0; CRAFT_API_KEY set in the process environment
   * @expectedResult The right key dispatches end to end, a wrong key is refused, and no key is refused with the remedy: the docs example is executed, not asserted
   */
  test("static key: the documented recipe admits the key and refuses everything else", async () => {
    const recipe = extractStaticKeyRecipe();
    expect(recipe).toContain("timingSafeStringEqual");
    const dir = mkdtempSync(join(import.meta.dir, "tmp-ladder-recipe-"));
    try {
      const file = join(dir, "craft.config.ts");
      writeFileSync(file, recipe, "utf8");
      const key = "static-ladder-key-please-change-me";
      process.env["CRAFT_API_KEY"] = key;
      const mod = (await import(pathToFileURL(file).href)) as {
        default: CraftConfig & {
          servers: { default: { port: number } };
        };
      };
      const config = mod.default;
      const url = await boot(
        {
          ...config,
          servers: {
            default: { ...config.servers.default, port: 0, host: "127.0.0.1" },
          },
        },
        [greet()],
      );

      const admitted = await execCommand("greet", ["--name=key"], {
        url,
        token: key,
        ...isolated(),
      });
      expect(admitted.code).toBe(EXEC_EXIT.ok);
      expect(admitted.output).toBe("hello key");

      const wrongKey = await execCommand("greet", ["--name=key"], {
        url,
        token: "not-the-key",
        ...isolated(),
      });
      expect(wrongKey.code).toBe(EXEC_EXIT.refused);

      const noKey = await execCommand("greet", ["--name=key"], {
        url,
        ...isolated(),
      });
      expect(noKey.code).toBe(EXEC_EXIT.refused);
      expect(noKey.error).toMatch(/--token/);
    } finally {
      delete process.env["CRAFT_API_KEY"];
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * @case Rung 3: a self-signed JWT minted with jose, admitted by jwt() on a scope-guarded route
   * @preconditions Server-level jwt({ secret, issuer, audience }); the dispatch tier gated on ops:dispatch; the route guarded with .authorize({ scopes }); a token minted in the test with jose carrying both scopes
   * @expectedResult The minted token passes the tier AND the route's own .authorize() end to end; a token missing the route scope passes the tier and fails the route, so the guard provably ran
   */
  test("self-signed JWT: minted with jose, admitted through tier and route guard", async () => {
    const secret = "ladder-jwt-secret-please-change-me";
    const issuer = "https://ops.example.test";
    const audience = "https://ops.example.test";
    const mint = (scope: string): Promise<string> =>
      new SignJWT({ scope })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject("operator")
        .setExpirationTime("8h")
        .sign(new TextEncoder().encode(secret));

    const url = await boot(
      {
        servers: {
          default: {
            port: 0,
            host: "127.0.0.1",
            auth: jwt({ secret, issuer, audience }),
          },
        },
        plugins: [opsPlugin({ tiers: { dispatch: "ops:dispatch" } })],
      },
      [
        craft()
          .id("resolve")
          .authorize({ scopes: ["orders:resolve"] })
          .from(direct())
          .transform(() => "resolved")
          .to(noop()),
      ],
    );

    const admitted = await execCommand("resolve", [], {
      url,
      token: await mint("ops:dispatch orders:resolve"),
      ...isolated(),
    });
    expect(admitted.code).toBe(EXEC_EXIT.ok);
    expect(admitted.output).toBe("resolved");

    // Two-sided: the same credential minus the route scope reaches the tier
    // and is refused by the route's own guard, proving the admit above went
    // through the guard rather than around it.
    const underScoped = await execCommand("resolve", [], {
      url,
      token: await mint("ops:dispatch"),
      ...isolated(),
    });
    expect(underScoped.code).toBe(EXEC_EXIT.failed);
  });
});
