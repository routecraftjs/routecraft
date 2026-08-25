import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import {
  craft,
  simple,
  http,
  RoutecraftError,
  type Exchange,
  type HttpClientOptions,
  type HttpResult,
} from "@routecraft/routecraft";

/**
 * `maxBodySize` and `redirect` on the `http()` client, exercised against a
 * real `node:http` server rather than a fetch double, because both options
 * are about what the transport does: a declared `Content-Length`, a chunked
 * body that declares nothing, and a 3xx that a mock would never produce.
 *
 * The server deliberately answers some routes by writing to the raw socket.
 * That is the only way to declare a `Content-Length` that disagrees with the
 * bytes actually sent, which is the case the cap has to survive.
 */

const CAP = 1000;

let server: Server;
let base: string;

/**
 * Sockets the suite deliberately leaves mid-response. They are answered by
 * hand rather than through `res.end()`, so nothing else will close them and
 * `server.close()` would wait on them forever.
 */
const held: Socket[] = [];

/** Bodies the suite serves, sized around {@link CAP}. */
const UNDER = "u".repeat(CAP - 1);
const AT = "a".repeat(CAP);
const OVER = "o".repeat(CAP + 1);

/** A declared length far enough above {@link CAP} to be unmistakable in an error message. */
const DECLARED_OVER = CAP * 100;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "/";

    if (url === "/under" || url === "/at" || url === "/over") {
      const body = url === "/under" ? UNDER : url === "/at" ? AT : OVER;
      res.writeHead(200, {
        "content-type": "text/plain",
        "content-length": String(body.length),
      });
      res.end(body);
      return;
    }

    // No Content-Length: only the streaming count can catch this one.
    if (url === "/chunked-over") {
      res.writeHead(200, { "content-type": "text/plain" });
      for (let i = 0; i < 20; i++) res.write("c".repeat(200));
      res.end();
      return;
    }

    // Declares far above the cap and sends it, so the declaration alone must
    // trigger the refusal. It must not stall: Bun's fetch does not resolve
    // until the declared length is satisfied or the stream ends.
    if (url === "/over-declaring") {
      const body = "d".repeat(DECLARED_OVER);
      res.writeHead(200, {
        "content-type": "text/plain",
        "content-length": String(DECLARED_OVER),
      });
      res.end(body);
      return;
    }

    // Declares far less than it sends: the low declaration must not buy the
    // body a pass.
    if (url === "/under-declaring") {
      const socket = res.socket;
      if (socket) {
        held.push(socket);
        socket.write(
          [
            "HTTP/1.1 200 OK",
            "Content-Type: text/plain",
            "Content-Length: 10",
            "",
            "u".repeat(CAP * 10),
          ].join("\r\n"),
        );
        socket.end();
      }
      return;
    }

    if (url === "/json-over") {
      const payload = JSON.stringify({ pad: "j".repeat(CAP) });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(payload.length),
      });
      res.end(payload);
      return;
    }

    if (url === "/error-over") {
      res.writeHead(500, {
        "content-type": "text/plain",
        "content-length": String(OVER.length),
      });
      res.end(OVER);
      return;
    }

    if (url === "/redirect") {
      res.writeHead(302, { location: "/destination", "x-hop": "first" });
      res.end("moved");
      return;
    }

    // No Location: every runtime hands the 3xx back even under "follow".
    if (url === "/dangling-redirect") {
      res.writeHead(302, { "content-type": "text/plain" });
      res.end("nowhere");
      return;
    }

    if (url === "/destination") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("arrived");
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("nope");
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server did not bind to a port");
  }
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  for (const socket of held) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * Drive the client through the public factory. The size cap is a property
 * of the adapter's read, not of any operation wrapped around it, so the
 * tests below assert on it without a route in the way.
 */
async function callClient(
  options: HttpClientOptions<unknown>,
): Promise<HttpResult> {
  const enricher = http(options);
  return (await enricher.fetch({} as Exchange<unknown>, {})) as HttpResult;
}

/** The `rc` code of whatever `build` throws, for construction-time guards. */
function rcOf(build: () => unknown): string | undefined {
  try {
    build();
  } catch (error) {
    return (error as { rc?: string }).rc;
  }
  return undefined;
}

describe("http() client maxBodySize", () => {
  /**
   * @case A response one byte under the cap is returned whole
   * @preconditions Server declares and sends CAP - 1 bytes; client caps at CAP
   * @expectedResult The body arrives intact, so the boundary is not off by one in the refusing direction
   */
  test("accepts a body one byte under the cap", async () => {
    const result = await callClient({
      url: `${base}/under`,
      maxBodySize: CAP,
    });

    expect(result.status).toBe(200);
    expect(result.body).toBe(UNDER);
  });

  /**
   * @case A response exactly at the cap is returned whole
   * @preconditions Server declares and sends exactly CAP bytes; client caps at CAP
   * @expectedResult The body arrives intact, because the cap is a maximum and not an exclusive bound
   */
  test("accepts a body exactly at the cap", async () => {
    const result = await callClient({
      url: `${base}/at`,
      maxBodySize: CAP,
    });

    expect(result.status).toBe(200);
    expect(result.body).toBe(AT);
  });

  /**
   * @case A response one byte over the cap fails the exchange
   * @preconditions Server declares and sends CAP + 1 bytes; client caps at CAP
   * @expectedResult RC5061 naming the option and both numbers, and no truncated body handed back
   */
  test("refuses a body one byte over the cap", async () => {
    const promise = callClient({ url: `${base}/over`, maxBodySize: CAP });

    await expect(promise).rejects.toThrow(/maxBodySize/);
    const error = await promise.catch((e: unknown) => e);
    expect((error as RoutecraftError).rc).toBe("RC5061");
    expect((error as Error).message).toContain(String(CAP + 1));
    expect((error as Error).message).toContain(String(CAP));
  });

  /**
   * @case A chunked response that declares no length is caught while streaming
   * @preconditions Server sends 4000 bytes with no Content-Length; client caps at CAP
   * @expectedResult RC5061, proving the running count enforces the cap where a declaration cannot
   */
  test("refuses an over-sized chunked body with no declared length", async () => {
    const promise = callClient({
      url: `${base}/chunked-over`,
      maxBodySize: CAP,
    });

    await expect(promise).rejects.toThrow(/maxBodySize/);
    const error = await promise.catch((e: unknown) => e);
    expect((error as RoutecraftError).rc).toBe("RC5061");
  });

  /**
   * @case A Content-Length that overstates the body is refused on the declaration alone
   * @preconditions Server declares and sends CAP * 100 bytes; client caps at CAP
   * @expectedResult RC5061 naming the declared number rather than a counted one, which is what proves the declaration was refused on its own rather than the body being read and measured
   */
  test("refuses on a declared Content-Length above the cap", async () => {
    const promise = callClient({
      url: `${base}/over-declaring`,
      maxBodySize: CAP,
    });

    await expect(promise).rejects.toThrow(/maxBodySize/);
    const error = await promise.catch((e: unknown) => e);
    expect((error as RoutecraftError).rc).toBe("RC5061");
    expect((error as Error).message).toContain(String(DECLARED_OVER));
  });

  /**
   * @case A Content-Length that understates the body never buys the body a pass
   * @preconditions Server declares 10 bytes and sends CAP * 10; client caps at CAP
   * @expectedResult Either a rejection or a body no larger than the cap, never the full over-sized payload. Node truncates the read at the declared length and Bun rejects the connection outright, so the two runtimes reach the same guarantee by different routes and the assertion covers both
   */
  test("never returns more than the cap when Content-Length understates the body", async () => {
    const result = await callClient({
      url: `${base}/under-declaring`,
      maxBodySize: CAP,
    }).catch((e: unknown) => e);

    if (result instanceof Error) return;

    const body = (result as HttpResult).body;
    expect(typeof body).toBe("string");
    expect((body as string).length).toBeLessThanOrEqual(CAP);
  });

  /**
   * @case An over-sized JSON response fails rather than parsing a truncated document
   * @preconditions Server returns application/json larger than the cap
   * @expectedResult RC5061 and no partially parsed object, because half a document that parses is worse than a failure
   */
  test("refuses an over-sized JSON body instead of truncating it", async () => {
    const promise = callClient({ url: `${base}/json-over`, maxBodySize: CAP });

    await expect(promise).rejects.toThrow(/maxBodySize/);
    const error = await promise.catch((e: unknown) => e);
    expect((error as RoutecraftError).rc).toBe("RC5061");
  });

  /**
   * @case The cap applies to an error response as well as a successful one
   * @preconditions Server answers 500 with a body over the cap; throwOnHttpError left at its default
   * @expectedResult RC5061 rather than the HTTP error, with the status named in the message so the underlying failure stays legible
   */
  test("applies the cap to an error response and names the status", async () => {
    const promise = callClient({ url: `${base}/error-over`, maxBodySize: CAP });

    await expect(promise).rejects.toThrow(/maxBodySize/);
    const error = await promise.catch((e: unknown) => e);
    expect((error as RoutecraftError).rc).toBe("RC5061");
    expect((error as Error).message).toContain("HTTP 500");
  });

  /**
   * @case The cap defaults to 10 MB, matching the http plugin's inbound cap
   * @preconditions Client sets no maxBodySize; server returns a body far under 10 MB
   * @expectedResult The body arrives, so the default is a real ceiling rather than an unset one
   */
  test("defaults to 10 MB when the option is omitted", async () => {
    const result = await callClient({ url: `${base}/over` });

    expect(result.status).toBe(200);
    expect(result.body).toBe(OVER);
  });

  /**
   * @case A maxBodySize that is not a positive integer is refused at the http({...}) call site
   * @preconditions maxBodySize of 0, of -1 and of 1.5 passed to the client factory
   * @expectedResult RC5003 at construction, rather than a client that silently rejects every response it receives. Fractional values are refused alongside the non-positive ones because a byte count is a whole number, and rounding one on the author's behalf would mean the cap enforced is not the cap written
   */
  test("refuses a maxBodySize that is not a positive integer at construction", () => {
    for (const value of [0, -1, 1.5]) {
      expect(() => http({ url: `${base}/at`, maxBodySize: value })).toThrow();
      expect(rcOf(() => http({ url: `${base}/at`, maxBodySize: value }))).toBe(
        "RC5003",
      );
    }
  });

  /**
   * @case Infinity is the named way to say "no limit"
   * @preconditions maxBodySize: Infinity against a body larger than the default cap
   * @expectedResult The body arrives whole, so an endpoint that legitimately returns more than 10 MB has an opt-out that reads as intent rather than a magic number
   */
  test("accepts Infinity as an explicit opt-out", async () => {
    const result = await callClient({
      url: `${base}/over`,
      maxBodySize: Number.POSITIVE_INFINITY,
    });

    expect(result.status).toBe(200);
    expect(result.body).toBe(OVER);
  });

  /**
   * @case An over-sized response fails the enclosing exchange, not just the adapter call
   * @preconditions A route enriches from an endpoint returning more than the cap allows
   * @expectedResult The route's error handler sees RC5061 and the destination receives nothing
   */
  test("fails the exchange when used from a route", async () => {
    const s = spy();
    const seen: unknown[] = [];
    let t: TestContext | undefined;

    try {
      t = await testContext()
        .routes(
          craft()
            .id("http-client-max-body-size")
            .error((error) => {
              seen.push(error);
              return "handled";
            })
            .from(simple("trigger"))
            .enrich(http({ url: `${base}/over`, maxBodySize: CAP }))
            .to(s),
        )
        .build();

      await t.ctx.start();
    } finally {
      await t?.stop();
    }

    expect(s.received).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect((seen[0] as RoutecraftError).rc).toBe("RC5061");
  });
});

describe("http() client redirect", () => {
  /**
   * @case The default follows redirects exactly as before the option existed
   * @preconditions Client sets no redirect option; server 302s to /destination
   * @expectedResult The final 200 body, so no existing route changes behaviour
   */
  test("follows redirects by default", async () => {
    const result = await callClient({ url: `${base}/redirect` });

    expect(result.status).toBe(200);
    expect(result.body).toBe("arrived");
  });

  /**
   * @case An explicit "follow" behaves identically to the default
   * @preconditions redirect: "follow" against the same 302
   * @expectedResult The final 200 body
   */
  test("follows redirects when asked explicitly", async () => {
    const result = await callClient({
      url: `${base}/redirect`,
      redirect: "follow",
    });

    expect(result.status).toBe(200);
    expect(result.body).toBe("arrived");
  });

  /**
   * @case "manual" hands the 3xx back with Location readable
   * @preconditions redirect: "manual" against a 302 carrying Location and a custom header
   * @expectedResult Status 302 and the Location header on the result, so a route can re-run its own URL rule on the next hop
   */
  test("returns the 3xx itself under manual, with Location readable", async () => {
    const result = await callClient({
      url: `${base}/redirect`,
      redirect: "manual",
    });

    expect(result.status).toBe(302);
    expect(result.headers["location"]).toBe("/destination");
    expect(result.headers["x-hop"]).toBe("first");
  });

  /**
   * @case A non-redirect failure still throws under manual
   * @preconditions redirect: "manual" against a path that 404s; throwOnHttpError left at its default
   * @expectedResult The call rejects, because opting out of following a redirect is not opting out of noticing a 404
   */
  test("still throws on a non-redirect error under manual", async () => {
    await expect(
      callClient({ url: `${base}/missing`, redirect: "manual" }),
    ).rejects.toThrow(/HTTP 404/);
  });

  /**
   * @case A 3xx under the default follow-mode still throws when it cannot be followed
   * @preconditions A 302 carrying no Location, so the runtime hands the 3xx back even under follow
   * @expectedResult throwOnHttpError fires, unchanged from before the option existed
   */
  test("throws on an unfollowable 3xx under follow", async () => {
    await expect(
      callClient({ url: `${base}/dangling-redirect` }),
    ).rejects.toThrow(/HTTP 302/);
  });
  /**
   * @case "error" fails the request rather than following
   * @preconditions redirect: "error" against the same 302
   * @expectedResult The call rejects. The message is the runtime's own and differs between Node and Bun, so only the rejection is asserted
   */
  test("fails the request under error", async () => {
    await expect(
      callClient({ url: `${base}/redirect`, redirect: "error" }),
    ).rejects.toThrow();
  });

  /**
   * @case An unknown redirect mode is refused at the http({...}) call site
   * @preconditions A string outside the platform's three modes passed as redirect
   * @expectedResult RC5003 at construction, rather than a route believing it opted out while the adapter kept following
   */
  test("refuses an unknown redirect mode at construction", () => {
    // Deliberately outside HttpRedirectMode: the guard exists for untyped JS
    // callers, so the test has to squeeze past the types to reach it.
    const build = () =>
      http({ url: `${base}/redirect`, redirect: "manual-ish" as "manual" });

    expect(build).toThrow();
    expect(rcOf(build)).toBe("RC5003");
  });
});
