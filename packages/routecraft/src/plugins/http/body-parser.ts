import { isRoutecraftError } from "../../brand";
import { rcError, type RCCode, type RoutecraftError } from "../../error";
import { declaredLengthOver } from "./max-body-size.ts";
import {
  verifyWebhookSignature,
  type HttpWebhookSignatureOptions,
  type HttpWebhookSignatureRejection,
} from "./webhook-signature";

export interface ParsedRequestBody {
  /** The parsed body in its post-parse shape. `undefined` for methods without a body. */
  body: unknown;
  /**
   * The exact wire bytes of the request body (empty for bodyless methods).
   * This is the same buffer the content-type parsers read from, so
   * populating it costs nothing; the dispatcher only attaches it to the
   * exchange when the route opted in via `http({ rawBody: true })`. When
   * that opt-in is active and the body itself is the raw bytes (unknown
   * content-type), `rawBytes` is a defensive copy so in-place body
   * mutation cannot corrupt it.
   */
  rawBytes: Uint8Array;
}

/** Body-stage error carrying the HTTP status the dispatcher should return. */
export type HttpBodyError = RoutecraftError & { httpStatus: number };

/**
 * RC5039 signature rejection thrown by the pre-parse gate. Carries the
 * typed bounded reason so the dispatcher's 401 body and the auth:rejected
 * event never have to re-derive it from `err.message` free text (which the
 * security standard forbids).
 */
export type HttpSignatureRejectionError = HttpBodyError & {
  signatureRejection: HttpWebhookSignatureRejection;
};

/** Type guard for the RC5039 signature rejection thrown by {@link parseRequestBody}. */
export function isSignatureRejection(
  err: unknown,
): err is HttpSignatureRejectionError {
  return isRoutecraftError(err) && (err as RoutecraftError).rc === "RC5039";
}

/**
 * Build a body-stage error tagged with the response status the dispatcher
 * should use. Carrying the status explicitly avoids the dispatcher having to
 * infer 413-vs-400 from the message text. Defaults to RC5018 (malformed or
 * oversized body); the signature gate passes RC5039.
 */
function bodyError(
  httpStatus: number,
  message: string,
  cause?: unknown,
  rc: RCCode = "RC5018",
): HttpBodyError {
  const err = rcError(rc, cause, { message }) as HttpBodyError;
  err.httpStatus = httpStatus;
  return err;
}

interface ParseOptions {
  maxBodySize: number;
  /**
   * When set, verify the raw body against the signature header before any
   * content-type parsing. Failures throw RC5039 tagged 401.
   */
  signature?: HttpWebhookSignatureOptions;
  /**
   * Whether the route opted in to raw-body exposure. Only consulted on the
   * unknown-content-type branch, where body and raw bytes would otherwise
   * alias the same buffer.
   */
  rawBody?: boolean;
}

/**
 * Methods whose requests carry no body. Exported because the http source's
 * construction-time signature guard must stay in lockstep with the skip
 * below: a method in this set never reaches the signature gate, so allowing
 * `signature` on it would silently disable verification.
 */
export const METHODS_WITHOUT_BODY: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "DELETE",
  "OPTIONS",
]);

const EMPTY_BODY = new Uint8Array(0);

/**
 * Read and parse the request body using a `Content-Type`-driven strategy.
 *
 * Buffers the full body in memory before parsing so we can enforce
 * `maxBodySize` deterministically, which means a chunked request over the cap
 * is held before it is refused. The `http()` client counts while it streams
 * instead; bringing that here is a follow-up.
 *
 * Methods listed in {@link METHODS_WITHOUT_BODY} produce
 * `{ body: undefined, rawBytes: <empty> }` without touching the request
 * stream, matching what fetch clients usually send for those verbs.
 *
 * @throws HttpBodyError RC5018 tagged with `httpStatus` 413 when the body
 * exceeds `maxBodySize`, or 400 when a typed body cannot be parsed.
 * @throws HttpSignatureRejectionError RC5039 tagged with `httpStatus` 401
 * when `opts.signature` is set and verification fails; carries the bounded
 * rejection reason as `signatureRejection`.
 */
export async function parseRequestBody(
  req: Request,
  opts: ParseOptions,
): Promise<ParsedRequestBody> {
  const method = req.method.toUpperCase();
  if (METHODS_WITHOUT_BODY.has(method)) {
    // `signature` on a bodyless method is rejected at http({...}) construction
    // time, so skipping verification here cannot silently disable a gate.
    return { body: undefined, rawBytes: EMPTY_BODY };
  }

  // Guard against oversized requests before buffering when the client
  // declares Content-Length.
  const declaredLength = declaredLengthOver(
    req.headers.get("content-length"),
    opts.maxBodySize,
  );
  if (declaredLength !== undefined) {
    throw bodyError(
      413,
      `request body of ${declaredLength} bytes exceeds maxBodySize ${opts.maxBodySize}`,
    );
  }

  // arrayBuffer() buffers the full body, so a chunked request over the cap is
  // held in memory before the post-buffer check below rejects it. The http()
  // client streams and counts instead (see its readBody); adopting that here
  // is a follow-up, and the reason this side still buffers is history rather
  // than a missing mechanism.
  const buffer = await req.arrayBuffer();
  if (buffer.byteLength > opts.maxBodySize) {
    throw bodyError(
      413,
      `request body of ${buffer.byteLength} bytes exceeds maxBodySize ${opts.maxBodySize}`,
    );
  }

  const bytes = new Uint8Array(buffer);

  // Verify the signature before the zero-length shortcut and before any
  // content-type parsing: a signature-gated route must reject an empty or
  // malformed body that is not correctly signed, not admit it by accident.
  if (opts.signature) {
    const result = verifyWebhookSignature(
      bytes,
      req.headers.get(opts.signature.header),
      opts.signature,
    );
    if (!result.ok) {
      const err = bodyError(
        401,
        result.reason,
        undefined,
        "RC5039",
      ) as HttpSignatureRejectionError;
      err.signatureRejection = result.reason;
      throw err;
    }
  }

  if (buffer.byteLength === 0) {
    return { body: undefined, rawBytes: bytes };
  }

  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();

  if (contentType.includes("application/json")) {
    const text = new TextDecoder().decode(bytes);
    try {
      return { body: JSON.parse(text), rawBytes: bytes };
    } catch (err) {
      throw bodyError(400, "request body is not valid JSON", err);
    }
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = new TextDecoder().decode(bytes);
    const params = new URLSearchParams(text);
    const obj: Record<string, string> = {};
    for (const [k, v] of params) obj[k] = v;
    return { body: obj, rawBytes: bytes };
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
      return { body: formData, rawBytes: bytes };
    } catch (err) {
      throw bodyError(400, "multipart/form-data body could not be parsed", err);
    }
  }

  if (contentType.startsWith("text/")) {
    return { body: new TextDecoder().decode(bytes), rawBytes: bytes };
  }

  // Unknown content-type: the body IS the raw bytes. When the route wants
  // rawBody, hand it a defensive copy so an in-place body mutation cannot
  // corrupt the wire bytes the header promises; without the opt-in the
  // shared instance is never exposed twice, so no copy is needed.
  return {
    body: bytes,
    rawBytes: opts.rawBody === true ? bytes.slice() : bytes,
  };
}
