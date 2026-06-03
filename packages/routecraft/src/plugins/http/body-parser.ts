import { rcError, type RoutecraftError } from "../../error";

export interface ParsedRequestBody {
  /** The parsed body in its post-parse shape. `undefined` for methods without a body. */
  body: unknown;
  /** Raw byte length read off the wire. Useful for telemetry and quota tracking. */
  bytes: number;
}

/** RC5018 carrying the HTTP status the dispatcher should return. */
export type HttpBodyError = RoutecraftError & { httpStatus: number };

/**
 * Build an RC5018 error tagged with the response status the dispatcher should
 * use. Carrying the status explicitly avoids the dispatcher having to infer
 * 413-vs-400 from the message text.
 */
function bodyError(
  httpStatus: number,
  message: string,
  cause?: unknown,
): HttpBodyError {
  const err = rcError("RC5018", cause, { message }) as HttpBodyError;
  err.httpStatus = httpStatus;
  return err;
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
 * @throws HttpBodyError RC5018 tagged with `httpStatus` 413 when the body
 * exceeds `maxBodySize`, or 400 when a typed body cannot be parsed.
 */
export async function parseRequestBody(
  req: Request,
  opts: ParseOptions,
): Promise<ParsedRequestBody> {
  const method = req.method.toUpperCase();
  if (METHODS_WITHOUT_BODY.has(method)) {
    return { body: undefined, bytes: 0 };
  }

  // Guard against oversized requests before buffering when the client
  // declares Content-Length. Chunked transfers still require the post-buffer
  // check below (the fetch API provides no streaming byte-count hook).
  const declaredLength = parseInt(req.headers.get("content-length") ?? "", 10);
  if (!isNaN(declaredLength) && declaredLength > opts.maxBodySize) {
    throw bodyError(
      413,
      `request body of ${declaredLength} bytes exceeds maxBodySize ${opts.maxBodySize}`,
    );
  }

  // arrayBuffer() buffers the full body. The post-buffer check below catches
  // chunked transfers whose true size wasn't known from Content-Length.
  const buffer = await req.arrayBuffer();
  if (buffer.byteLength > opts.maxBodySize) {
    throw bodyError(
      413,
      `request body of ${buffer.byteLength} bytes exceeds maxBodySize ${opts.maxBodySize}`,
    );
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
      throw bodyError(400, "request body is not valid JSON", err);
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
      throw bodyError(400, "multipart/form-data body could not be parsed", err);
    }
  }

  if (contentType.startsWith("text/")) {
    return { body: new TextDecoder().decode(bytes), bytes: buffer.byteLength };
  }

  return { body: bytes, bytes: buffer.byteLength };
}
