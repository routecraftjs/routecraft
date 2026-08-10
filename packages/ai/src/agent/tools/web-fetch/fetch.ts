import { rcError } from "@routecraft/routecraft";
import { assertFetchableUrl } from "./ssrf.ts";

/**
 * The fetch step of the WebFetch pipeline: turn a URL into bytes, under
 * an address guard, a byte cap, and a deadline.
 *
 * Kept separate from extraction and conversion so an alternative reader
 * (a browser-backed or reader-API-backed variant, see
 * routecraftjs/routecraft#341) can replace this step alone without
 * touching how the result is turned into markdown.
 */

/** One resource read off the network, or the redirect that stopped us. */
export interface FetchedResource {
  /** URL actually read, after any same-host redirects. */
  url: string;
  /** Lowercased media type with parameters stripped; `""` when absent. */
  contentType: string;
  /** Decoded body. Empty when {@link crossHostRedirect} is set. */
  body: string;
  /** True when the body hit the byte cap and was cut short. */
  bodyTruncated: boolean;
  /**
   * Target of a cross-host redirect that was deliberately not followed.
   * The model gets the URL back and decides whether to fetch it, which
   * keeps a redirect from laundering one host's allowlist status into
   * another's.
   */
  crossHostRedirect?: string;
}

/** Bounds applied to a single fetch. */
export interface FetchBounds {
  /** Hard cap on bytes read off the wire. */
  maxBytes: number;
  /** Deadline for the whole walk, redirects included. */
  timeoutMs: number;
  /** Same-host redirect hops permitted before giving up. */
  maxRedirects: number;
  /** Host allowlist, checked on every hop. Empty means any public host. */
  allowedDomains: readonly string[];
  /**
   * Media types the caller can render. Checked against the response
   * header before the body is read, so a PDF or an image costs one set
   * of headers rather than a full download that is then discarded.
   */
  acceptedTypes: ReadonlySet<string>;
}

/**
 * Content negotiation preference. Markdown first, because a server that
 * can serve it saves the extraction step entirely and returns something
 * closer to what the model should read; HTML next; anything else last.
 */
const ACCEPT_HEADER =
  "text/markdown;q=1.0, text/html;q=0.9, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.1";

/**
 * Sent so operators of fetched sites can identify and rate-limit the
 * traffic. Deliberately honest about being an automated agent rather
 * than impersonating a browser.
 */
const USER_AGENT =
  "Routecraft-WebFetch/1.0 (+https://routecraft.dev/docs/reference/plugins/agentplugin)";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Read `target` under the supplied bounds.
 *
 * The request is always a credential-free GET: no caller-supplied
 * headers, no cookies, no authorization. A tool the model aims at
 * arbitrary URLs must not be able to spend the deployment's credentials
 * on an arbitrary host.
 *
 * @param target - URL to read.
 * @param bounds - Byte, time, redirect, and host bounds.
 * @param signal - Caller's abort signal, honoured alongside the deadline.
 */
export async function fetchResource(
  target: string,
  bounds: FetchBounds,
  signal: AbortSignal,
): Promise<FetchedResource> {
  let current = parseUrl(target);
  const deadline = AbortSignal.timeout(bounds.timeoutMs);
  const combined = AbortSignal.any([signal, deadline]);

  for (let hop = 0; hop <= bounds.maxRedirects; hop++) {
    // Raced against the deadline because `dns.lookup` takes no abort
    // signal, and a resolver that hangs would otherwise hold the walk
    // past `timeoutMs` once per hop.
    await Promise.race([
      assertFetchableUrl(current, bounds.allowedDomains),
      rejectOnAbort(combined, current, deadline, bounds.timeoutMs),
    ]);

    const response = await request(current, combined, deadline, bounds);

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      // Cancel eagerly: a redirect body is never read, and leaving it
      // undrained holds the socket open until GC.
      await response.body?.cancel();
      if (!location) {
        throw rcError("AI3002", undefined, {
          message: `WebFetch: ${current.href} returned ${response.status} with no Location header.`,
        });
      }
      const next = resolveLocation(location, current);
      // Origin, not host: `host` carries no scheme, so comparing it would
      // treat an https to http redirect on the same name as a same-host
      // hop and quietly move the fetch onto cleartext.
      if (next.origin !== current.origin) {
        return {
          url: current.href,
          contentType: "",
          body: "",
          bodyTruncated: false,
          crossHostRedirect: next.href,
        };
      }
      current = next;
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw rcError("AI3002", undefined, {
        message: `WebFetch: ${current.href} returned HTTP ${response.status} ${response.statusText}.`,
      });
    }

    const contentType = (response.headers.get("content-type") ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase();

    if (!bounds.acceptedTypes.has(contentType)) {
      await response.body?.cancel();
      throw rcError("AI3003", undefined, {
        message:
          `WebFetch: ${current.href} returned unsupported content type ` +
          `"${contentType}". This tool reads HTML, markdown, and plain text.`,
      });
    }
    // The read is wrapped as well as the request: a deadline or a caller
    // abort that fires after the headers arrive rejects here instead, and
    // an unwrapped rejection would reach the model as a bare
    // "The operation timed out" carrying neither the URL nor AI3002's
    // retryable metadata.
    let read: { text: string; truncated: boolean };
    try {
      read = await readCapped(
        response,
        bounds.maxBytes,
        contentTypeCharset(response.headers.get("content-type")),
      );
    } catch (cause) {
      throw rcError("AI3002", cause, {
        message: abortMessage(current, deadline, bounds.timeoutMs),
      });
    }
    const { text, truncated } = read;
    return {
      url: current.href,
      contentType,
      body: text,
      bodyTruncated: truncated,
    };
  }

  throw rcError("AI3002", undefined, {
    message: `WebFetch: exceeded ${bounds.maxRedirects} same-host redirects starting from ${target}.`,
  });
}

function parseUrl(raw: string): URL {
  try {
    return new URL(raw);
  } catch (cause) {
    throw rcError("AI3001", cause, {
      message: `WebFetch: "${raw}" is not a valid absolute URL.`,
    });
  }
}

function resolveLocation(location: string, base: URL): URL {
  try {
    return new URL(location, base);
  } catch (cause) {
    throw rcError("AI3002", cause, {
      message: `WebFetch: ${base.href} redirected to an unparseable Location "${location}".`,
    });
  }
}

async function request(
  url: URL,
  signal: AbortSignal,
  deadline: AbortSignal,
  bounds: FetchBounds,
): Promise<Response> {
  try {
    return await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: {
        accept: ACCEPT_HEADER,
        "accept-language": "en",
        "user-agent": USER_AGENT,
      },
    });
  } catch (cause) {
    throw rcError("AI3002", cause, {
      message: abortMessage(url, deadline, bounds.timeoutMs),
    });
  }
}

/**
 * A promise that never resolves and rejects with `AI3002` the moment
 * `signal` aborts. Used to put a deadline around work that takes no
 * abort signal of its own.
 */
function rejectOnAbort(
  signal: AbortSignal,
  url: URL,
  deadline: AbortSignal,
  timeoutMs: number,
): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = () =>
      reject(
        rcError("AI3002", undefined, {
          message: abortMessage(url, deadline, timeoutMs),
        }),
      );
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
  });
}

/**
 * Describe a failure in terms of what actually stopped it.
 *
 * Discriminating on the deadline signal rather than the combined one
 * matters: a route shutting down cancels the caller's signal, and
 * reporting that as "did not complete within 30000ms" would send an
 * operator hunting a timeout that never happened.
 */
function abortMessage(
  url: URL,
  deadline: AbortSignal,
  timeoutMs: number,
): string {
  if (deadline.aborted) {
    return `WebFetch: ${url.href} did not complete within ${timeoutMs}ms.`;
  }
  return `WebFetch: request to ${url.href} failed.`;
}

/** Charset from a Content-Type header, defaulting to UTF-8. */
function contentTypeCharset(header: string | null): string {
  const match = header?.match(/charset\s*=\s*"?([^";]+)"?/i);
  return match?.[1]?.trim() ?? "utf-8";
}

/**
 * Read at most `maxBytes` from the response.
 *
 * Streamed rather than `await response.text()` so a hostile or merely
 * enormous host cannot make us buffer a gigabyte before we notice the
 * cap. Content-Length is not trusted for this: it is optional, and a
 * chunked response can simply lie.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
  charset: string,
): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (!body) return { text: "", truncated: false };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
    // A body that ended exactly at the cap is complete, not truncated;
    // only an unread remainder counts. One more read distinguishes them.
    if (!truncated && total >= maxBytes) {
      truncated = !(await reader.read()).done;
    }
  } finally {
    await reader.cancel().catch(() => {
      // The stream is already being torn down; a cancel failure here
      // would mask the real error on the throwing path.
    });
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { text: decode(joined, charset), truncated };
}

function decode(bytes: Uint8Array, charset: string): string {
  try {
    return decodeStreaming(charset, bytes);
  } catch {
    // An unrecognised charset label is the server's problem, not a
    // reason to fail the read; UTF-8 is the overwhelmingly likely truth.
    return decodeStreaming("utf-8", bytes);
  }
}

/**
 * Decode without a final flush. The byte cap lands at an arbitrary
 * offset, so the tail is often half a multi-byte sequence; streaming mode
 * drops the incomplete character instead of substituting U+FFFD into the
 * HTML that extraction then has to parse.
 */
function decodeStreaming(charset: string, bytes: Uint8Array): string {
  return new TextDecoder(charset).decode(bytes, { stream: true });
}
