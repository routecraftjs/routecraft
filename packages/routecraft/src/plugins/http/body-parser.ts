import { rcError } from "../../error";

export interface ParsedRequestBody {
  /** The parsed body in its post-parse shape. `undefined` for methods without a body. */
  body: unknown;
  /** Raw byte length read off the wire. Useful for telemetry and quota tracking. */
  bytes: number;
}

interface ParseOptions {
  maxBodySize: number;
}

const METHODS_WITHOUT_BODY = new Set(["GET", "HEAD", "DELETE", "OPTIONS"]);

/**
 * Read and parse the request body using a `Content-Type`-driven strategy.
 *
 * Buffers the full body in memory before parsing so we can enforce
 * `maxBodySize` deterministically. Streaming bodies are a follow-up.
 *
 * Methods listed in {@link METHODS_WITHOUT_BODY} produce `{ body: undefined, bytes: 0 }`
 * without touching the request stream, matching what fetch clients usually
 * send for those verbs.
 *
 * @throws RoutecraftError RC5018 when the body exceeds `maxBodySize` (the
 * caller converts this to a 413 response).
 */
export async function parseRequestBody(
  req: Request,
  opts: ParseOptions,
): Promise<ParsedRequestBody> {
  const method = req.method.toUpperCase();
  if (METHODS_WITHOUT_BODY.has(method)) {
    return { body: undefined, bytes: 0 };
  }

  // arrayBuffer() resolves the whole body. The fetch API does not currently
  // expose a "max" cap up-front; we count after the fact and reject.
  const buffer = await req.arrayBuffer();
  if (buffer.byteLength > opts.maxBodySize) {
    throw rcError("RC5018", undefined, {
      message: `request body of ${buffer.byteLength} bytes exceeds maxBodySize ${opts.maxBodySize}`,
    });
  }

  if (buffer.byteLength === 0) {
    return { body: undefined, bytes: 0 };
  }

  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  const bytes = new Uint8Array(buffer);

  if (contentType.includes("application/json")) {
    const text = new TextDecoder().decode(bytes);
    try {
      return { body: JSON.parse(text), bytes: buffer.byteLength };
    } catch (err) {
      throw rcError("RC5018", err, {
        message: "request body is not valid JSON",
      });
    }
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = new TextDecoder().decode(bytes);
    const params = new URLSearchParams(text);
    const obj: Record<string, string> = {};
    for (const [k, v] of params) obj[k] = v;
    return { body: obj, bytes: buffer.byteLength };
  }

  if (contentType.includes("multipart/form-data")) {
    // Rebuild a Request so the runtime's `formData()` parser sees both the
    // body and the boundary-bearing Content-Type. We cannot call
    // `req.formData()` directly because `req` is already consumed.
    const replay = new Request("http://internal.multipart.parser/", {
      method: "POST",
      headers: { "content-type": req.headers.get("content-type") ?? "" },
      body: buffer,
    });
    try {
      const formData = await replay.formData();
      return { body: formData, bytes: buffer.byteLength };
    } catch (err) {
      throw rcError("RC5018", err, {
        message: "multipart/form-data body could not be parsed",
      });
    }
  }

  if (contentType.startsWith("text/")) {
    return { body: new TextDecoder().decode(bytes), bytes: buffer.byteLength };
  }

  return { body: bytes, bytes: buffer.byteLength };
}
