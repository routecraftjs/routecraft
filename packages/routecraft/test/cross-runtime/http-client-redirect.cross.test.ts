import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import {
  http,
  type Exchange,
  type HttpClientOptions,
  type HttpResult,
} from "@routecraft/routecraft";

/**
 * Cross-runtime contract for the `http()` client's `redirect` and
 * `maxBodySize` options. Both are thin layers over the platform's own fetch,
 * and the platform is exactly where the two runtimes have historically
 * disagreed: `redirect: "manual"` returns an opaque filtered response in a
 * browser, and neither Node's undici nor Bun implements that filtering, so
 * what a route can actually read off a 3xx is a property of the runtime
 * rather than of the spec. This file pins it on both.
 *
 * `maxBodySize` is here for the same reason. The runtimes differ in when
 * `fetch` resolves (Node on headers, Bun once the body starts arriving), so
 * the cap's two arms need to be proven to produce the same outcome on both
 * rather than only on the one the unit suite happens to run under.
 *
 * The adapter-cross-runtime CI jobs run this file once per runtime.
 */

const CAP = 1000;
const DECLARED_OVER = CAP * 100;

let server: Server;
let base: string;

/** Sockets the fixture server currently has open, for the leak regression. */
let liveConnections = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "/";

    if (url === "/redirect") {
      res.writeHead(302, {
        location: "/destination",
        "x-hop": "first",
        "content-type": "text/plain",
      });
      res.end("moved");
      return;
    }

    if (url === "/permanent") {
      res.writeHead(301, { location: "/destination" });
      res.end("moved permanently");
      return;
    }

    if (url === "/destination") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("arrived");
      return;
    }

    if (url === "/big") {
      const body = "b".repeat(DECLARED_OVER);
      res.writeHead(200, {
        "content-type": "text/plain",
        "content-length": String(DECLARED_OVER),
      });
      res.end(body);
      return;
    }

    if (url === "/big-chunked") {
      res.writeHead(200, { "content-type": "text/plain" });
      for (let i = 0; i < 20; i++) res.write("c".repeat(200));
      res.end();
      return;
    }

    if (url === "/small") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("nope");
  });

  server.on("connection", (socket) => {
    liveConnections++;
    socket.on("close", () => liveConnections--);
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
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * Drive the client through the public factory, with no route in the way.
 * Both options are properties of the adapter's own request and read, so the
 * runtime contract is asserted directly against them.
 */
async function callClient(
  options: HttpClientOptions<unknown>,
): Promise<HttpResult> {
  const enricher = http(options);
  return (await enricher.fetch({} as Exchange<unknown>, {})) as HttpResult;
}

describe("http() client redirect (cross-runtime contract)", () => {
  /**
   * @case A 302 under manual is readable: status and Location both survive
   * @preconditions redirect: "manual" against a 302 carrying Location and a custom header
   * @expectedResult Status 302 with Location and x-hop readable on the result. This is the contract a route re-validating each hop depends on, and the one a browser would deny by returning an opaque response
   */
  test("manual exposes status and Location on a 302", async () => {
    const result = await callClient({
      url: `${base}/redirect`,
      redirect: "manual",
    });

    expect(result.status).toBe(302);
    expect(result.headers["location"]).toBe("/destination");
    expect(result.headers["x-hop"]).toBe("first");
  });

  /**
   * @case A 301 under manual is readable on the same terms as a 302
   * @preconditions redirect: "manual" against a 301
   * @expectedResult Status 301 and Location readable, so the contract is not specific to one redirect status
   */
  test("manual exposes status and Location on a 301", async () => {
    const result = await callClient({
      url: `${base}/permanent`,
      redirect: "manual",
    });

    expect(result.status).toBe(301);
    expect(result.headers["location"]).toBe("/destination");
  });

  /**
   * @case The 3xx body is readable under manual rather than stripped
   * @preconditions redirect: "manual" against a 302 whose body is "moved"
   * @expectedResult The body arrives, confirming the response is not the opaque filtered one a browser returns
   */
  test("manual returns the redirect response body", async () => {
    const result = await callClient({
      url: `${base}/redirect`,
      redirect: "manual",
    });

    expect(result.body).toBe("moved");
  });

  /**
   * @case A manual 3xx does not trip throwOnHttpError
   * @preconditions redirect: "manual" with throwOnHttpError at its default of true
   * @expectedResult The call resolves, because a 3xx is the outcome manual asked for and not a failure
   */
  test("manual does not treat the 3xx as an http error", async () => {
    await expect(
      callClient({ url: `${base}/redirect`, redirect: "manual" }),
    ).resolves.toBeDefined();
  });

  /**
   * @case A non-redirect failure still throws under manual
   * @preconditions redirect: "manual" against a path that 404s
   * @expectedResult The call rejects, because opting out of following a redirect is not opting out of noticing a 404
   */
  test("manual still throws on a non-redirect error", async () => {
    await expect(
      callClient({ url: `${base}/missing`, redirect: "manual" }),
    ).rejects.toThrow(/HTTP 404/);
  });

  /**
   * @case The default follows redirects on both runtimes
   * @preconditions No redirect option set; server 302s to /destination
   * @expectedResult The final 200 and its body, unchanged from before the option existed
   */
  test("follow is the default and reaches the destination", async () => {
    const result = await callClient({ url: `${base}/redirect` });

    expect(result.status).toBe(200);
    expect(result.body).toBe("arrived");
  });

  /**
   * @case "error" refuses the redirect on both runtimes
   * @preconditions redirect: "error" against the same 302
   * @expectedResult The call rejects. Only the rejection is asserted: Node raises a TypeError whose cause reads "unexpected redirect" while Bun raises an Error naming UnexpectedRedirect, so the message is the runtime's and not a contract
   */
  test("error refuses to follow", async () => {
    await expect(
      callClient({ url: `${base}/redirect`, redirect: "error" }),
    ).rejects.toThrow();
  });
});

describe("http() client maxBodySize (cross-runtime contract)", () => {
  /**
   * @case A declared Content-Length over the cap is refused identically on both runtimes
   * @preconditions Server declares and sends CAP * 100 bytes; client caps at CAP
   * @expectedResult RC5061 naming the declared number, so the early-refusal arm behaves the same whether fetch resolved on headers or on first bytes
   */
  test("refuses a declared Content-Length over the cap", async () => {
    const promise = callClient({ url: `${base}/big`, maxBodySize: CAP });

    await expect(promise).rejects.toThrow(/maxBodySize/);
    const error = await promise.catch((e: unknown) => e);
    expect((error as { rc?: string }).rc).toBe("RC5061");
    expect((error as Error).message).toContain(String(DECLARED_OVER));
  });

  /**
   * @case A chunked body over the cap is caught while streaming on both runtimes
   * @preconditions Server sends 4000 bytes with no Content-Length; client caps at CAP
   * @expectedResult RC5061 from the running count, proving the streaming arm works on both and not only where fetch resolves on headers
   */
  test("refuses an over-sized chunked body with no declared length", async () => {
    const promise = callClient({
      url: `${base}/big-chunked`,
      maxBodySize: CAP,
    });

    await expect(promise).rejects.toThrow(/maxBodySize/);
    const error = await promise.catch((e: unknown) => e);
    expect((error as { rc?: string }).rc).toBe("RC5061");
  });

  /**
   * @case A refusal releases the connection rather than leaking it
   * @preconditions Twenty calls refused on the declared Content-Length, each against a response the client never reads
   * @expectedResult The fixture server settles back to a handful of live connections. A response body that is neither read nor cancelled keeps its connection checked out and keeps the runtime buffering what the server sends, which is the cost the refusal exists to avoid. This lives here rather than in the unit suite because the leak is undici-specific: Bun releases the connection either way, so only the Node job can catch a regression
   */
  test("releases the connection when it refuses on the declaration", async () => {
    for (let i = 0; i < 20; i++) {
      await expect(
        callClient({ url: `${base}/big`, maxBodySize: CAP }),
      ).rejects.toThrow(/maxBodySize/);
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(liveConnections).toBeLessThan(5);
  });

  /**
   * @case A body under the cap is returned whole on both runtimes
   * @preconditions Server returns two bytes; client caps at CAP
   * @expectedResult The body arrives intact, so neither arm of the cap fires on a response that fits
   */
  test("returns a body under the cap untouched", async () => {
    const result = await callClient({ url: `${base}/small`, maxBodySize: CAP });

    expect(result.status).toBe(200);
    expect(result.body).toBe("ok");
  });
});
