import {
  afterAll,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  test,
} from "bun:test";
import { createServer, type Server } from "node:http";
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
 * `responseBody` on the `http()` client, exercised against a real `node:http`
 * server rather than a fetch double, because the whole subject is what
 * survives the transport: a decode that corrupts binary is invisible to a
 * mock that hands back the object it was given.
 */

let server: Server;
let base: string;

/**
 * A JPEG's opening bytes. Deliberately not valid UTF-8: `0xff` cannot begin a
 * UTF-8 sequence, so decoding replaces each with U+FFFD, which re-encodes to
 * three bytes. This is the shape that gets corrupted.
 */
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

/**
 * An Ogg page header: the ASCII "OggS" plus version and flags, so it is valid
 * UTF-8 by accident and survives a decode unharmed. Kept beside the JPEG
 * because the asymmetry is what disguised the original bug as anything but a
 * transport bug: voice notes worked while images beside them did not.
 */
const OGG_HEAD = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00]);

const JSON_BODY = Buffer.from('{"parsed":false}');

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/jpeg") {
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(JPEG_HEAD);
      return;
    }
    if (url === "/ogg") {
      res.writeHead(200, { "content-type": "audio/ogg" });
      res.end(OGG_HEAD);
      return;
    }
    if (url === "/json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON_BODY);
      return;
    }
    if (url === "/big") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.alloc(256, 0xff));
      return;
    }
    // No Content-Length, so the declared-length arm cannot fire and only the
    // streaming count can refuse this one.
    if (url === "/chunked-binary") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      for (let i = 0; i < 8; i++) res.write(Buffer.alloc(64, 0xff));
      res.end();
      return;
    }
    // A single byte that stringifies to valid JSON: String(Uint8Array([49]))
    // is "49", which JSON.parse turns into the number 49.
    if (url === "/one-byte-json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(Buffer.from([0x31]));
      return;
    }
    // Reports the Content-Type exactly as it arrived. A duplicate does not
    // show up as two headers: fetch merges same-named headers into one
    // comma-joined value, so the value is the only place the duplication is
    // visible.
    if (url === "/echo-content-type") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ contentType: req.headers["content-type"] }));
      return;
    }
    if (url === "/fail") {
      res.writeHead(500, { "content-type": "image/jpeg" });
      res.end(JPEG_HEAD);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Run one enrichment through a route and hand back what the client produced. */
async function callClient<R>(
  options: HttpClientOptions & { responseBody?: "text" | "bytes" },
): Promise<HttpResult<R>> {
  const s = spy();
  let t: TestContext | undefined;
  try {
    t = await testContext()
      .routes(
        craft()
          .id("client-bytes-probe")
          .from(simple("trigger"))
          .enrich(http(options))
          .to(s),
      )
      .build();
    await t.ctx.start();
  } finally {
    await t?.stop();
  }
  return (s.received[0] as Exchange<HttpResult<R>>).body;
}

describe("http() client responseBody", () => {
  /**
   * @case Binary survives the client byte for byte under "bytes"
   * @preconditions A JPEG-shaped body fetched with responseBody: "bytes"
   * @expectedResult The bytes arrive identical to the ones served, which is what the option exists to make possible
   */
  test("a JPEG-shaped body round trips identically", async () => {
    const result = await callClient<Uint8Array>({
      url: `${base}/jpeg`,
      responseBody: "bytes",
    });

    expect(result.body).toBeInstanceOf(Uint8Array);
    expect(Array.from(result.body)).toEqual(Array.from(JPEG_HEAD));
  });

  /**
   * @case The default mode still decodes, and that is lossy
   * @preconditions The same JPEG-shaped body fetched with responseBody omitted
   * @expectedResult A string whose re-encoding is longer than what was served and differs from it, pinning the behaviour the option is the escape from rather than leaving it implied
   */
  test("the default mode decodes the same body and corrupts it", async () => {
    const result = await callClient<string>({ url: `${base}/jpeg` });

    expect(typeof result.body).toBe("string");
    const reencoded = new TextEncoder().encode(result.body);
    expect(reencoded.byteLength).toBeGreaterThan(JPEG_HEAD.byteLength);
    expect(Array.from(reencoded)).not.toEqual(Array.from(JPEG_HEAD));
  });

  /**
   * @case An ASCII-safe binary body survives either mode
   * @preconditions An Ogg page header, valid UTF-8 by accident, fetched under bytes
   * @expectedResult Identical bytes. Pinned because this is the case that hid the bug: it works under both modes, so a suite testing only this one would have reported the client healthy
   */
  test("an Ogg-shaped body round trips identically", async () => {
    const result = await callClient<Uint8Array>({
      url: `${base}/ogg`,
      responseBody: "bytes",
    });

    expect(Array.from(result.body)).toEqual(Array.from(OGG_HEAD));
  });

  /**
   * @case JSON is handed over unparsed under bytes
   * @preconditions A response declaring application/json fetched with responseBody: "bytes"
   * @expectedResult The raw Uint8Array rather than a parsed object, because this mode's contract is the wire form and the content type does not override it
   */
  test("a JSON response is not parsed under bytes", async () => {
    const result = await callClient<Uint8Array>({
      url: `${base}/json`,
      responseBody: "bytes",
    });

    expect(result.body).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(result.body)).toBe('{"parsed":false}');
  });

  /**
   * @case JSON is still parsed under the default
   * @preconditions The same response with responseBody omitted
   * @expectedResult The parsed object, so the new arm did not disturb the existing content-type behaviour
   */
  test("a JSON response is still parsed under the default", async () => {
    const result = await callClient<{ parsed: boolean }>({
      url: `${base}/json`,
    });

    expect(result.body).toEqual({ parsed: false });
  });

  /**
   * @case The size cap counts bytes on the binary arm too
   * @preconditions responseBody: "bytes" with maxBodySize below the served length
   * @expectedResult The exchange fails RC5061, so the new read path is bounded exactly as the text path is rather than bypassing the cap
   */
  test("maxBodySize refuses an oversized binary body", async () => {
    const seen: unknown[] = [];
    let t: TestContext | undefined;
    try {
      t = await testContext()
        .routes(
          craft()
            .id("client-bytes-cap")
            .error((error) => {
              seen.push(error);
              return "handled";
            })
            .from(simple("trigger"))
            .enrich(
              http({
                url: `${base}/big`,
                responseBody: "bytes",
                maxBodySize: 16,
              }),
            )
            .to(spy()),
        )
        .build();
      await t.ctx.start();
    } finally {
      await t?.stop();
    }

    expect(seen).toHaveLength(1);
    expect((seen[0] as RoutecraftError).rc).toBe("RC5061");
  });

  /**
   * @case The streaming count bounds a binary body that declares no length
   * @preconditions A chunked binary response with no Content-Length, fetched under bytes with a cap below what arrives
   * @expectedResult RC5061 from the streaming arm. Separate from the test above on purpose: a body that declares its length is refused before a byte is read, so that test never exercises the per-chunk count on this path
   */
  test("the streaming count refuses a chunked binary body", async () => {
    const seen: unknown[] = [];
    let t: TestContext | undefined;
    try {
      t = await testContext()
        .routes(
          craft()
            .id("client-bytes-chunked-cap")
            .error((error) => {
              seen.push(error);
              return "handled";
            })
            .from(simple("trigger"))
            .enrich(
              http({
                url: `${base}/chunked-binary`,
                responseBody: "bytes",
                maxBodySize: 100,
              }),
            )
            .to(spy()),
        )
        .build();
      await t.ctx.start();
    } finally {
      await t?.stop();
    }

    expect(seen).toHaveLength(1);
    expect((seen[0] as RoutecraftError).rc).toBe("RC5061");
  });

  /**
   * @case Bytes are never handed to JSON.parse
   * @preconditions A one-byte body declaring application/json, fetched under bytes. String(Uint8Array([49])) is "49", which parses as the number 49
   * @expectedResult The raw single-byte array. Without the guard the body would silently become a number, which is the narrow case where parsing a Uint8Array succeeds instead of throwing
   */
  test("a byte body that stringifies to valid JSON is left alone", async () => {
    const result = await callClient<Uint8Array>({
      url: `${base}/one-byte-json`,
      responseBody: "bytes",
    });

    expect(result.body).toBeInstanceOf(Uint8Array);
    expect(Array.from(result.body)).toEqual([0x31]);
  });

  /**
   * @case A failing response names the body's shape rather than decoding it
   * @preconditions throwOnHttpError with responseBody: "bytes" against a 500 carrying binary
   * @expectedResult The message reports the byte count and content type. Decoding the body to build the message would reintroduce, on the error path, the corruption this option removes
   */
  test("throwOnHttpError names the byte count instead of decoding", async () => {
    const seen: unknown[] = [];
    let t: TestContext | undefined;
    try {
      t = await testContext()
        .routes(
          craft()
            .id("client-bytes-error")
            .error((error) => {
              seen.push(error);
              return "handled";
            })
            .from(simple("trigger"))
            .enrich(
              http({
                url: `${base}/fail`,
                responseBody: "bytes",
                throwOnHttpError: true,
              }),
            )
            .to(spy()),
        )
        .build();
      await t.ctx.start();
    } finally {
      await t?.stop();
    }

    expect(seen).toHaveLength(1);
    const message = String(
      (seen[0] as { message?: string })?.message ?? seen[0],
    );
    expect(message).toContain("HTTP 500");
    expect(message).toContain(`${JPEG_HEAD.byteLength} bytes`);
    expect(message).toContain("image/jpeg");
  });

  /**
   * @case The client sends one Content-Type whatever casing the route used
   * @preconditions A POST with an object body and the route setting `content-type` in lowercase, which is what a route written from the wire spelling does
   * @expectedResult The header arrives once, as plain "application/json". The client used to check for the exact string "Content-Type", so a lowercase one did not count and it added its own beside it, which fetch merges into "application/json, application/json"
   */
  test("a lowercase content-type is not duplicated by the client", async () => {
    const result = await callClient<{ contentType: string }>({
      url: `${base}/echo-content-type`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { hello: "world" },
    });

    // Under the case-sensitive check the client added its own header beside
    // the route's, and fetch merged the pair into "application/json, application/json".
    expect(result.body.contentType).toBe("application/json");
  });

  /**
   * @case The canonical casing is still not duplicated either
   * @preconditions The same request with the header spelled "Content-Type"
   * @expectedResult The same single value, so the case-insensitive lookup did not break the spelling that already worked
   */
  test("a canonical Content-Type is not duplicated either", async () => {
    const result = await callClient<{ contentType: string }>({
      url: `${base}/echo-content-type`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { hello: "world" },
    });

    expect(result.body.contentType).toBe("application/json");
  });

  /**
   * @case The body callback gets its exchange type without an annotation
   * @preconditions http<{ id: string }>({ body: (ex) => ... }) with the parameter left unannotated
   * @expectedResult The parameter is Exchange<{ id: string }>. The option used to be `unknown | ((ex) => unknown)`, which TypeScript collapses to `unknown`, so the callback form had no contextual type and every call site annotated by hand
   */
  test("the body callback receives a typed exchange", () => {
    http<{ id: string }>({
      url: `${base}/jpeg`,
      method: "POST",
      body: (ex) => {
        expectTypeOf(ex).toEqualTypeOf<Exchange<{ id: string }>>();
        return { id: ex.body.id };
      },
    });
  });

  /**
   * @case The bytes overload types the result without a type argument
   * @preconditions http({ responseBody: "bytes" }) with no explicit result type parameter
   * @expectedResult The enricher's result body is Uint8Array, so a feature whose point is that the body is bytes does not ask the author to say so twice
   */
  test("responseBody bytes types the result as Uint8Array", () => {
    const bytesAdapter = http({
      url: `${base}/jpeg`,
      responseBody: "bytes",
    });
    type ResultBody = Awaited<ReturnType<typeof bytesAdapter.fetch>>["body"];
    expectTypeOf<ResultBody>().toEqualTypeOf<Uint8Array>();
    // Referenced at runtime so the value is not dead: the assertion above is
    // the point, but lint reads a type-only use as unused.
    expect(typeof bytesAdapter.fetch).toBe("function");
  });

  /**
   * @case An unknown responseBody is refused at the call site
   * @preconditions http({ responseBody }) built with a value outside the union, as an untyped caller would
   * @expectedResult RC5003 from http({...}) itself, rather than a route that silently falls back to the default and corrupts what it fetches
   */
  test("an invalid responseBody throws RC5003 at construction", () => {
    expect(() =>
      http({
        url: `${base}/jpeg`,
        responseBody: "binary" as "bytes",
      }),
    ).toThrow(/RC5003|invalid responseBody/);
  });
});
