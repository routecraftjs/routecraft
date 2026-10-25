import { describe, test, expect, afterEach } from "vitest";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  http,
  noop,
  type CraftConfig,
  type EventName,
} from "@routecraft/routecraft";

/**
 * Cross-runtime contract for cookies on `http()`: reading them by name, and
 * setting several in one response.
 *
 * The two server engines write `Set-Cookie` differently. `Bun.serve` sends
 * the `Response` as it is, while the node:http shim copies headers onto a
 * `ServerResponse` and reads cookies through `getSetCookie()`, so a route's
 * several cookies have to be shown to arrive as separate fields on each,
 * through the buffered arm, the streaming arm and a responder alike.
 */

/**
 * Start a test context serving `routes` on an ephemeral port and resolve
 * with the context and the port it bound.
 */
async function bootHttp(
  routes: Parameters<ReturnType<typeof testContext>["routes"]>[0],
): Promise<{ ctx: TestContext; port: number }> {
  let port = 0;
  const ctx = await testContext()
    .on(
      "server:listening" as EventName,
      ((payload: { details: unknown }) => {
        port = (payload.details as { port: number }).port;
      }) as Parameters<ReturnType<typeof testContext>["on"]>[1],
    )
    .routes(routes)
    .with({
      servers: { default: { host: "127.0.0.1", port: 0 } },
      http: { server: "default" },
    } as CraftConfig)
    .build();
  await ctx.startAndWaitReady();
  expect(port).toBeGreaterThan(0);
  return { ctx, port };
}

const SESSION = "session=abc; Path=/; HttpOnly; Secure; SameSite=Lax";
const CLEARED =
  "pending-login=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";

describe("http cookies (cross-runtime contract)", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) {
      await t.stop();
      t = undefined;
    }
  });

  /**
   * @case A route sets one cookie and clears another in one response
   * @preconditions A route whose response headers carry set-cookie as an array of two cookies, a location and a 303 status, as a sign-in callback sends
   * @expectedResult Both arrive as separate Set-Cookie fields, in order, beside the location and the 303
   */
  test("an array of set-cookie sends one field per cookie", async () => {
    const bound = await bootHttp(
      craft()
        .id("cookie-callback")
        .from(http({ path: "/callback", method: "GET" }))
        .header("routecraft.http.response.headers", {
          location: "/",
          "set-cookie": [SESSION, CLEARED],
        })
        .header("routecraft.http.response.status", 303)
        .to(noop()),
    );
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/callback`, {
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.getSetCookie()).toEqual([SESSION, CLEARED]);
  });

  /**
   * @case Two spellings of set-cookie in one override are one header
   * @preconditions Response headers naming "set-cookie" and "Set-Cookie", each with one cookie
   * @expectedResult Both cookies arrive, in the order written, where the last one used to win alone
   */
  test("set-cookie spelt two ways sends both cookies", async () => {
    const bound = await bootHttp(
      craft()
        .id("cookie-spellings")
        .from(http({ path: "/spellings", method: "GET" }))
        .header("routecraft.http.response.headers", {
          "set-cookie": "a=1; Path=/",
          "Set-Cookie": "b=2; Path=/",
        })
        .to(noop()),
    );
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/spellings`);
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  /**
   * @case Two spellings of another header keep the last, and an empty array removes a header
   * @preconditions Response headers naming "Content-Type" then "content-type" with different types, x-powered-by as an empty array over a value set earlier in the same override, and set-cookie as an empty array over a cookie an earlier "Set-Cookie" spelling set
   * @expectedResult The content type is the last spelling's alone, never the two joined, and neither x-powered-by nor any Set-Cookie field is sent
   */
  test("other headers keep their last spelling; an empty array removes", async () => {
    const bound = await bootHttp(
      craft()
        .id("cookie-last-spelling")
        .from(http({ path: "/last", method: "GET" }))
        .header("routecraft.http.response.headers", {
          "Content-Type": "text/plain",
          "content-type": "application/x-ndjson",
          "X-Powered-By": "routecraft",
          "x-powered-by": [],
          "Set-Cookie": "stale=1; Path=/",
          "set-cookie": [],
        })
        .transform(() => "{}")
        .to(noop()),
    );
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/last`);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    expect(res.headers.has("x-powered-by")).toBe(false);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  /**
   * @case A single set-cookie string behaves as before, and an array on another header combines
   * @preconditions Response headers with set-cookie as one string and vary as an array of two values
   * @expectedResult One Set-Cookie field carrying the string, and one vary field joining the two values with ", "
   */
  test("a single cookie is unchanged; other arrays combine", async () => {
    const bound = await bootHttp(
      craft()
        .id("cookie-single")
        .from(http({ path: "/single", method: "GET" }))
        .header("routecraft.http.response.headers", {
          "set-cookie": SESSION,
          vary: ["accept", "origin"],
        })
        .to(noop()),
    );
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/single`);
    expect(res.headers.getSetCookie()).toEqual([SESSION]);
    expect(res.headers.get("vary")).toBe("accept, origin");
  });

  /**
   * @case A streaming response carries several cookies
   * @preconditions A route answering with an async iterable (an SSE stream) and set-cookie as an array of two cookies
   * @expectedResult The event-stream response carries both Set-Cookie fields and its frames
   */
  test("the streaming arm sends several cookies", async () => {
    const bound = await bootHttp(
      craft()
        .id("cookie-stream")
        .from(http({ path: "/stream", method: "GET" }))
        .header("routecraft.http.response.headers", {
          "set-cookie": [SESSION, CLEARED],
        })
        .transform(async function* () {
          yield { event: "tick", data: { n: 0 } };
        })
        .to(noop()),
    );
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/stream`);
    expect(res.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(res.headers.getSetCookie()).toEqual([SESSION, CLEARED]);
    expect(await res.text()).toContain('data: {"n":0}');
  });

  /**
   * @case A responder answers with several cookies, reading the request's
   * @preconditions A responder that reads the pending-login cookie from its request view and returns set-cookie as an array
   * @expectedResult The responder saw the cookie by name, and both Set-Cookie fields arrive
   */
  test("a responder reads a cookie and sends several", async () => {
    let seen: string | undefined;
    const bound = await bootHttp(
      craft()
        .id("cookie-respond")
        .from(
          http({
            path: "/respond",
            method: "POST",
            respond: ({ request }) => {
              seen = request.cookies["pending-login"];
              return {
                status: 200,
                headers: { "set-cookie": [SESSION, CLEARED] },
                body: { ok: true },
              };
            },
          }),
        )
        .to(noop()),
    );
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "pending-login=xyz",
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(seen).toBe("xyz");
    expect(res.headers.getSetCookie()).toEqual([SESSION, CLEARED]);
  });

  /**
   * @case A route reads the request's cookies by name
   * @preconditions A Cookie header with whitespace, a value holding "=", a name sent twice, a pair with no "=", an empty name, and a cookie named "__proto__"; and a request with no Cookie header
   * @expectedResult Each name maps to its trimmed value split on the first "=", the first of a repeated name wins, the malformed pairs are skipped, "__proto__" is an ordinary name, an unsent name such as "constructor" reads as undefined, and a request with no cookies sees an empty map
   */
  test("cookies arrive parsed by name", async () => {
    const seen: Array<Record<string, string>> = [];
    const unsent: unknown[] = [];
    const bound = await bootHttp(
      craft()
        .id("cookie-read")
        .from(http({ path: "/read", method: "GET" }))
        .process((ex) => {
          const cookies = ex.headers["routecraft.http.cookies"];
          seen.push({ ...cookies });
          unsent.push(cookies?.["constructor"]);
          return ex;
        })
        .to(noop()),
    );
    t = bound.ctx;

    await fetch(`http://127.0.0.1:${bound.port}/read`, {
      headers: {
        cookie:
          "a=1;  token = x=y== ; a=2; flag; =orphan; __proto__=p; theme=dark",
      },
    });
    await fetch(`http://127.0.0.1:${bound.port}/read`);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({
      a: "1",
      token: "x=y==",
      ["__proto__"]: "p",
      theme: "dark",
    });
    expect(Object.keys(seen[0]!)).toEqual(["a", "token", "__proto__", "theme"]);
    expect(seen[1]).toEqual({});
    expect(unsent).toEqual([undefined, undefined]);
  });
});
