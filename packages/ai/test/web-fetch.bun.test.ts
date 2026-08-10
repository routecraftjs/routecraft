import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { testFn } from "@routecraft/testing";
import { webFetch, type WebFetchResult } from "../src/index.ts";

/**
 * Behaviour tests for the built-in `WebFetch` tool.
 *
 * `globalThis.fetch` is stubbed, following the convention in
 * `packages/routecraft/test/http.bun.test.ts`, so nothing here touches
 * the network. Hosts are public IP literals rather than names: the
 * egress guard resolves names through `node:dns/promises` and short
 * circuits on literals, which keeps this file free of a module mock that
 * would be process-global across the whole run.
 *
 * The extraction and conversion steps run for real against `linkedom`,
 * `@mozilla/readability`, and `turndown`, so the markdown asserted here
 * is the markdown a model would see.
 */

/** A public unicast literal, so the guard passes without a resolver. */
const HOST = "93.184.216.34";
const OTHER_HOST = "93.184.216.35";

function respond(
  body: string,
  contentType = "text/html; charset=utf-8",
): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": contentType },
  });
}

function redirect(location: string, status = 301): Response {
  return new Response(null, { status, headers: { location } });
}

/** Markdown long enough to exceed a small `maxLength`. */
function longMarkdown(length: number): string {
  return "a".repeat(length);
}

async function call(
  options: Parameters<typeof webFetch>[0],
  input: unknown,
): Promise<WebFetchResult> {
  return (await testFn(webFetch(options), input)) as WebFetchResult;
}

describe("WebFetch tool", () => {
  let fetchMock: ReturnType<typeof mock>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = mock();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * @case An HTML article comes back as markdown with its title
   * @preconditions Server returns a text/html document with a title and an article body
   * @expectedResult Result carries the title, markdown headings and prose, and no navigation chrome
   */
  test("converts an HTML article to markdown", async () => {
    fetchMock.mockResolvedValue(
      respond(
        `<html><head><title>Widget Guide</title></head><body>
           <nav><a href="/somewhere">Skip me</a></nav>
           <article>
             <h1>Installing the widget</h1>
             <p>Run the installer, then restart the service.</p>
             <p>The widget listens on port 8080 by default.</p>
           </article>
         </body></html>`,
      ),
    );

    const result = await call({}, { url: `http://${HOST}/guide` });

    expect(result.title).toBe("Widget Guide");
    expect(result.content).toContain("Installing the widget");
    expect(result.content).toContain("restart the service");
    expect(result.content).not.toContain("Skip me");
    expect(result.truncated).toBe(false);
  });

  /**
   * @case A server that honours the markdown-first Accept header is not re-processed
   * @preconditions Server returns text/markdown containing syntax an HTML extractor would mangle
   * @expectedResult The body is returned verbatim, proving extraction was skipped
   */
  test("returns server-supplied markdown verbatim", async () => {
    const markdown = "# Title\n\n- one\n- two\n\n```js\nconst a = 1;\n```";
    fetchMock.mockResolvedValue(respond(markdown, "text/markdown"));

    const result = await call({}, { url: `http://${HOST}/readme.md` });

    expect(result.content).toBe(markdown);
    expect(result.truncated).toBe(false);
  });

  /**
   * @case The outgoing request carries no caller credentials and follows no redirects itself
   * @preconditions Any successful fetch
   * @expectedResult Request is a GET with redirect "manual", an Accept preferring markdown, and no cookie or authorization header
   */
  test("issues a credential-free GET with manual redirects", async () => {
    fetchMock.mockResolvedValue(respond("hi", "text/plain"));

    await call({}, { url: `http://${HOST}/` });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit & {
      headers: Record<string, string>;
    };
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    expect(init.headers["accept"]).toMatch(/text\/markdown/);
    expect(Object.keys(init.headers).map((k) => k.toLowerCase())).not.toContain(
      "authorization",
    );
    expect(Object.keys(init.headers).map((k) => k.toLowerCase())).not.toContain(
      "cookie",
    );
  });

  /**
   * @case Output longer than the character bound is cut and says so
   * @preconditions maxLength of 100 against a 250-character markdown document
   * @expectedResult truncated is true, totalLength is the full length, the content ends with a visible notice naming both, and nextOffset points at the resume point
   */
  test("truncates long output with a visible notice", async () => {
    fetchMock.mockResolvedValue(respond(longMarkdown(250), "text/markdown"));

    const result = await call({ maxLength: 100 }, { url: `http://${HOST}/` });

    expect(result.truncated).toBe(true);
    expect(result.totalLength).toBe(250);
    expect(result.nextOffset).toBe(100);
    expect(result.content).toMatch(
      /\[WebFetch: Showing characters 0 to 100 of 250\./,
    );
    expect(result.content).toMatch(/offset=100/);
    // The slice itself is intact ahead of the notice.
    expect(result.content.startsWith(longMarkdown(100))).toBe(true);
  });

  /**
   * @case A continuation offset returns the next windowful, still bounded
   * @preconditions maxLength of 100, offset of 100, against the same 250-character document
   * @expectedResult Characters 100 to 200 come back, still truncated, offering 200 as the next resume point
   */
  test("continues from a supplied offset", async () => {
    fetchMock.mockResolvedValue(respond(longMarkdown(250), "text/markdown"));

    const result = await call(
      { maxLength: 100 },
      { url: `http://${HOST}/`, offset: 100 },
    );

    expect(result.truncated).toBe(true);
    expect(result.nextOffset).toBe(200);
    expect(result.content).toMatch(/Showing characters 100 to 200 of 250\./);
  });

  /**
   * @case The final section of a paginated read closes the walk
   * @preconditions maxLength of 100, offset of 200, against the same 250-character document
   * @expectedResult The last 50 characters come back, truncated is false, and no further offset is offered
   */
  test("ends the walk on the final section", async () => {
    fetchMock.mockResolvedValue(respond(longMarkdown(250), "text/markdown"));

    const result = await call(
      { maxLength: 100 },
      { url: `http://${HOST}/`, offset: 200 },
    );

    expect(result.truncated).toBe(false);
    expect(result.nextOffset).toBeUndefined();
    expect(result.content).toMatch(/Showing characters 200 to 250 of 250\./);
  });

  /**
   * @case An offset past the end of the document is an error, not an empty result
   * @preconditions offset of 5000 against a 250-character document
   * @expectedResult Rejects with AI2003 naming the document length
   */
  test("rejects an offset past the end of the document", async () => {
    fetchMock.mockResolvedValue(respond(longMarkdown(250), "text/markdown"));

    const error = await call({}, { url: `http://${HOST}/`, offset: 5000 }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toMatchObject({ rc: "AI2003" });
    expect((error as Error).message).toMatch(/past the end/i);
  });

  /**
   * @case A response cut short by the byte cap says the source itself was clipped
   * @preconditions maxBytes of 50 against a 400-byte markdown body
   * @expectedResult The notice states the download limit was hit, distinguishing a clipped source from a merely paginated one
   */
  test("reports when the byte cap clipped the source", async () => {
    fetchMock.mockResolvedValue(respond(longMarkdown(400), "text/markdown"));

    const result = await call({ maxBytes: 50 }, { url: `http://${HOST}/` });

    expect(result.content).toMatch(/download limit/i);
  });

  /**
   * @case A same-host redirect is followed transparently
   * @preconditions First response is a 301 to another path on the same host, second is content
   * @expectedResult Content of the final URL is returned and the result names that URL
   */
  test("follows a same-host redirect", async () => {
    fetchMock
      .mockResolvedValueOnce(redirect(`http://${HOST}/final`))
      .mockResolvedValueOnce(respond("arrived", "text/plain"));

    const result = await call({}, { url: `http://${HOST}/start` });

    expect(result.content).toBe("arrived");
    expect(result.url).toBe(`http://${HOST}/final`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  /**
   * @case A cross-host redirect is reported rather than followed
   * @preconditions Response is a 302 pointing at a different host
   * @expectedResult redirectedTo names the target, no second fetch is made, and the content explains the decision
   */
  test("does not follow a cross-host redirect", async () => {
    fetchMock.mockResolvedValue(
      redirect(`http://${OTHER_HOST}/elsewhere`, 302),
    );

    const result = await call({}, { url: `http://${HOST}/start` });

    expect(result.redirectedTo).toBe(`http://${OTHER_HOST}/elsewhere`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.content).toMatch(/redirects to a different host/i);
  });

  /**
   * @case A redirect that a host allowlist would not permit cannot be reached by bouncing
   * @preconditions allowedDomains permits only the first host; it redirects to a host outside the list
   * @expectedResult The target is reported back rather than fetched, so the allowlist is never circumvented
   */
  test("cannot be bounced past an allowlist by a redirect", async () => {
    fetchMock.mockResolvedValue(redirect(`http://${OTHER_HOST}/elsewhere`));

    const result = await call(
      { allowedDomains: [HOST] },
      { url: `http://${HOST}/start` },
    );

    expect(result.redirectedTo).toBe(`http://${OTHER_HOST}/elsewhere`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * @case A redirect that keeps the host but drops to http is not followed
   * @preconditions An https URL redirects to the same hostname over plain http
   * @expectedResult Reported as a cross-host redirect rather than followed, so the fetch is never silently downgraded to cleartext
   */
  test("does not follow an https to http downgrade on the same host", async () => {
    fetchMock.mockResolvedValue(redirect(`http://${HOST}/downgraded`));

    const result = await call({}, { url: `https://${HOST}/secure` });

    expect(result.redirectedTo).toBe(`http://${HOST}/downgraded`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * @case A redirect to a different port on the same hostname is not followed
   * @preconditions An https URL redirects to the same hostname on an explicit non-default port
   * @expectedResult Reported as a cross-host redirect, since the origin changed even though the hostname did not
   */
  test("does not follow a port change on the same host", async () => {
    fetchMock.mockResolvedValue(redirect(`https://${HOST}:8443/elsewhere`));

    const result = await call({}, { url: `https://${HOST}/start` });

    expect(result.redirectedTo).toBe(`https://${HOST}:8443/elsewhere`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * @case A redirect loop stops at the configured hop limit
   * @preconditions maxRedirects of 2 against a host that always redirects to itself
   * @expectedResult Rejects with AI2002 naming the limit
   */
  test("stops after the redirect limit", async () => {
    fetchMock.mockResolvedValue(redirect(`http://${HOST}/again`));

    const error = await call(
      { maxRedirects: 2 },
      { url: `http://${HOST}/start` },
    ).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toMatchObject({ rc: "AI2002" });
    expect((error as Error).message).toMatch(/redirects/i);
  });

  /**
   * @case A redirect without a Location header is an error
   * @preconditions Response is a 301 carrying no Location
   * @expectedResult Rejects with AI2002
   */
  test("rejects a redirect with no Location", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 301 }));

    const error = await call({}, { url: `http://${HOST}/` }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toMatchObject({ rc: "AI2002" });
  });

  /**
   * @case A non-2xx response surfaces as a tool error the model can react to
   * @preconditions Server returns 404
   * @expectedResult Rejects with AI2002 naming the status
   */
  test("rejects a non-2xx response", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));

    const error = await call({}, { url: `http://${HOST}/missing` }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toMatchObject({ rc: "AI2002" });
    expect((error as Error).message).toMatch(/404/);
  });

  /**
   * @case Binary content is refused rather than returned as mojibake
   * @preconditions Server returns application/pdf
   * @expectedResult Rejects with AI2003 naming the content type and what the tool does read
   */
  test("rejects an unsupported content type", async () => {
    fetchMock.mockResolvedValue(respond("%PDF-1.7", "application/pdf"));

    const error = await call({}, { url: `http://${HOST}/doc.pdf` }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toMatchObject({ rc: "AI2003" });
    expect((error as Error).message).toMatch(/application\/pdf/);
  });

  /**
   * @case An unsupported content type is refused on its headers, not after a full download
   * @preconditions Server returns application/pdf with a body
   * @expectedResult Rejects with AI2003 and the response body stream is cancelled rather than read
   */
  test("refuses an unsupported content type without reading the body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("%PDF-1.7"));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    fetchMock.mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    );

    const error = await call({}, { url: `http://${HOST}/doc.pdf` }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toMatchObject({ rc: "AI2003" });
    expect(cancelled).toBe(true);
  });

  /**
   * @case A truncation boundary never splits an astral character in half
   * @preconditions maxLength lands exactly between the two surrogate halves of an emoji
   * @expectedResult The boundary moves back one unit so neither response carries a lone surrogate
   */
  test("keeps truncation boundaries on code-point boundaries", async () => {
    // Each emoji is two UTF-16 units, so maxLength 5 would otherwise cut
    // the third one in half.
    fetchMock.mockResolvedValue(respond("ab🙂🙂🙂", "text/markdown"));

    const first = await call({ maxLength: 5 }, { url: `http://${HOST}/` });
    const body = first.content.split("\n\n---\n")[0]!;

    expect(body).toBe("ab🙂");
    expect(first.nextOffset).toBe(4);
    // No unpaired surrogate survived into the response.
    expect([...body].every((ch) => ch.codePointAt(0)! !== 0xfffd)).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(body)).toBe(false);
  });

  /**
   * @case An unknown input property is rejected rather than silently dropped
   * @preconditions Input carries a misspelled "offsett" alongside a valid url
   * @expectedResult Validation fails, matching the published additionalProperties: false, so a mistyped continuation cannot loop on page one
   */
  test("rejects unknown input properties", async () => {
    fetchMock.mockResolvedValue(respond("hi", "text/plain"));

    const error = await call(
      {},
      {
        url: `http://${HOST}/`,
        offsett: 100,
      },
    ).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeDefined();
    expect((error as Error).message).toMatch(/offsett/);
  });

  /**
   * @case Fractional bounds are rejected at registration
   * @preconditions A factory configured with a fractional maxLength and, separately, a fractional timeoutMs
   * @expectedResult Both throw RC5003, since a fractional maxLength would advertise a schema-invalid offset and a fractional timeoutMs throws inside AbortSignal.timeout
   */
  test("rejects fractional bounds at registration", () => {
    expect(() => webFetch({ maxLength: 1.5 })).toThrow(/positive integer/);
    expect(() => webFetch({ timeoutMs: 1.5 })).toThrow(/positive integer/);
    expect(() => webFetch({ maxBytes: 1.5 })).toThrow(/positive integer/);
  });

  /**
   * @case The registered tool advertises itself as safe to repeat
   * @preconditions A default-configured factory
   * @expectedResult Tags are read-only and idempotent, matching the other built-in read tools
   */
  test("registers as read-only and idempotent", () => {
    expect(webFetch().tags).toEqual(["read-only", "idempotent"]);
  });

  /**
   * @case Nonsense bounds are rejected at registration, not at first call
   * @preconditions A factory configured with a zero maxBytes
   * @expectedResult Throws RC5003 immediately, so the misconfiguration surfaces at context init
   */
  test("rejects invalid bounds at registration", () => {
    expect(() => webFetch({ maxBytes: 0 })).toThrow(/maxBytes/);
    expect(() => webFetch({ maxBytes: 0 })).toThrowError(
      expect.objectContaining({ rc: "RC5003" }),
    );
  });

  /**
   * @case A malformed allowlist entry is caught at registration rather than failing every call
   * @preconditions allowedDomains carries a full URL instead of a bare hostname
   * @expectedResult Throws RC5003 naming the offending index, so the typo surfaces at context init
   */
  test("rejects malformed allowedDomains entries at registration", () => {
    expect(() =>
      webFetch({ allowedDomains: ["https://docs.example.com"] }),
    ).toThrow(/allowedDomains\[0\]/);
    expect(() => webFetch({ allowedDomains: ["example.com/guide"] })).toThrow(
      /allowedDomains\[0\]/,
    );
    expect(() => webFetch({ allowedDomains: ["  "] })).toThrow(
      /allowedDomains\[0\]/,
    );
  });

  /**
   * @case The allowlist is copied at registration, so mutating the caller's array cannot widen it
   * @preconditions A factory registered with an array that is then pushed to, and a fetch aimed at the pushed host
   * @expectedResult The later host is still refused with AI2001, proving the array was not captured by reference
   */
  test("does not widen the allowlist when the caller's array is mutated", async () => {
    const domains = ["allowed.example"];
    const spec = webFetch({ allowedDomains: domains });
    domains.push("sneaky.example");
    fetchMock.mockResolvedValue(respond("hi", "text/plain"));

    const error = await testFn(spec, {
      url: "http://sneaky.example/",
    }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toMatchObject({ rc: "AI2001" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * @case Continuation instructions do not name a tool name the caller may not have used
   * @preconditions A truncated page, from a factory the caller could register under any name
   * @expectedResult The notice says "this tool" rather than a hard-coded WebFetch, so continuation works under any registered name
   */
  test("phrases the continuation notice without a hard-coded tool name", async () => {
    fetchMock.mockResolvedValue(respond(longMarkdown(250), "text/markdown"));

    const result = await call({ maxLength: 100 }, { url: `http://${HOST}/` });

    expect(result.content).toMatch(/Call this tool again with offset=100/);
    expect(result.content).not.toMatch(/Call WebFetch again/);
  });

  /**
   * @case HTML past the extraction ceiling is refused rather than blocking the event loop
   * @preconditions A text/html body larger than the hard MAX_EXTRACTABLE_CHARS ceiling, with maxBytes raised to let it through the wire cap
   * @expectedResult Rejects with AI2003 naming the ceiling, and no extraction is attempted
   */
  test("refuses HTML past the extraction ceiling", async () => {
    const huge = `<html><body>${"<p>x</p>".repeat(100_000)}</body></html>`;
    fetchMock.mockResolvedValue(respond(huge));

    const error = await call(
      { maxBytes: 20_000_000 },
      { url: `http://${HOST}/huge` },
    ).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toMatchObject({ rc: "AI2003" });
    expect((error as Error).message).toMatch(/will extract/i);
  });

  /**
   * @case An empty document read from a stale continuation offset errors instead of reporting a backwards range
   * @preconditions A page whose markdown is empty, read with a non-zero offset
   * @expectedResult Rejects with AI2003, the same as any other offset past the end, rather than emitting "characters 500 to 0 of 0"
   */
  test("rejects a non-zero offset into an empty document", async () => {
    fetchMock.mockResolvedValue(respond("   ", "text/plain"));

    const error = await call({}, { url: `http://${HOST}/`, offset: 500 }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toMatchObject({ rc: "AI2003" });
    expect((error as Error).message).toMatch(/past the end/i);
  });

  /**
   * @case An empty document read from the start is not an error
   * @preconditions A page whose markdown is empty, read with no offset
   * @expectedResult Returns empty content rather than throwing, since offset 0 into an empty page is legitimate
   */
  test("allows an empty document at offset zero", async () => {
    fetchMock.mockResolvedValue(respond("   ", "text/plain"));

    const result = await call({}, { url: `http://${HOST}/` });

    expect(result.content).toBe("");
    expect(result.truncated).toBe(false);
    expect(result.totalLength).toBe(0);
  });
});
