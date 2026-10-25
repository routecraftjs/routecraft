import { createHash } from "node:crypto";
import { rcError } from "./error.ts";
import {
  HeadersKeys,
  getExchangeContext,
  getExchangeRoute,
  type Exchange,
} from "./exchange.ts";

/**
 * Carrying a journey across a door: W3C Trace Context on the wire, mapped to
 * and from Routecraft's correlation and causation ids.
 *
 * Two headers cross the wire, `traceparent` and `tracestate`:
 *
 * - `traceparent` is the standard one, so an OpenTelemetry service on the
 *   other side parents its spans correctly. With the telemetry plugin on, its
 *   trace and parent ids are the current exchange span's. Without it, the
 *   trace id derives from the correlation id and the parent id from the
 *   exchange id.
 * - `tracestate` carries one member, `rc=c:<correlation>;x:<exchange>`: the
 *   exact Routecraft ids, so a Routecraft peer keeps the correlation string
 *   and records causation without guessing from the lossy `traceparent`
 *   fields.
 *
 * Correlation is an observability claim and never authority: nothing that
 * authorizes, caches, rate-limits or resumes reads it. Still, a caller who
 * can attach its requests to another chain can pollute that chain's ledger,
 * which is why a door adopts an inbound context only under
 * {@link TraceContextMode}.
 */

/**
 * Whether a door adopts an inbound trace context.
 *
 * - `"authenticated"` (the default): only when the door verified a principal
 *   for the request.
 * - `"always"`: from any caller, for a mount whose callers are all trusted
 *   (an internal network, a gateway that authenticates in front).
 * - `"never"`: every inbound request starts a new chain.
 */
export type TraceContextMode = "authenticated" | "always" | "never";

/** The two W3C Trace Context headers, as they cross the wire. */
export interface TraceContextCarrier {
  /** `00-<trace-id>-<parent-id>-<flags>` */
  readonly traceparent: string;
  /** `rc=c:<correlation id>;x:<exchange id>` */
  readonly tracestate: string;
}

/**
 * The longest correlation or causation id the engine accepts from outside it
 * (a door, `.correlate()`, a source). It keeps the `tracestate` member under
 * the 256-character limit W3C sets for one value.
 */
export const MAX_TRACE_ID_LENGTH = 128;

const TRACE_ID_PATTERN = /^[A-Za-z0-9._~:-]+$/;
const TRACEPARENT_PATTERN =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-.*)?$/;
const ALL_ZERO = /^0+$/;

/**
 * Header that hands an adopted remote `traceparent` from a door to the
 * telemetry plugin, so the exchange span becomes the remote span's child.
 * Kept only on the exchange the door built: a `direct()` call from a live
 * exchange drops it, since the caller's span is the callee's parent, and
 * only a route's ingress offers it to the lineage index, so a continuation
 * of the same exchange days later is a root of its own trace.
 *
 * @internal
 */
export const TRACE_PARENT_HEADER = "routecraft.trace.parent";

/**
 * Whether a value is a correlation or causation id the engine accepts from
 * outside it: a string of 1 to {@link MAX_TRACE_ID_LENGTH} characters from
 * `[A-Za-z0-9._~:-]`. The engine's own ids are UUIDs, which fit.
 *
 * @param value - The candidate id
 * @returns Whether it is well formed
 */
export function isTraceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TRACE_ID_LENGTH &&
    TRACE_ID_PATTERN.test(value)
  );
}

/**
 * Refuse a malformed correlation or causation id supplied by code (a source
 * adapter's `emit`, `.correlate()`, `CraftClient` headers). Code that builds
 * an id is under the author's control, so a bad one is a programming error,
 * unlike a door's inbound header, which is ignored.
 *
 * @param value - The supplied id
 * @param name - What it is, for the message
 * @param site - Where it was supplied, for the message
 * @throws RC5003 when the value is not a well-formed id
 * @internal
 */
export function assertTraceId(
  value: unknown,
  name: string,
  site: string,
): void {
  if (isTraceId(value)) return;
  throw rcError("RC5003", undefined, {
    message: `${site} supplied a ${name} that is not a well-formed id: it must be a string of 1 to ${MAX_TRACE_ID_LENGTH} characters from [A-Za-z0-9._~:-].`,
    suggestion: `Pass an id the engine minted (an exchange's correlation or exchange id), or a key of your own in that alphabet; hash a longer value first.`,
  });
}

/** The span a telemetry plugin holds for an exchange, as the wire needs it. */
export interface SpanContextLike {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
}

/**
 * Per context, the telemetry plugin's lookup from exchange id to its live
 * exchange span. Keyed by context id because a plugin sees that id on every
 * event and never the context object.
 */
const SPAN_SOURCES = new Map<
  string,
  (exchangeId: string) => SpanContextLike | undefined
>();

/**
 * Register the lookup a telemetry plugin offers for outbound `traceparent`.
 *
 * @param contextId - The context the plugin instruments
 * @param source - Exchange id to its live span, or undefined when none
 * @returns The unregister function
 * @internal
 */
export function registerSpanSource(
  contextId: string,
  source: (exchangeId: string) => SpanContextLike | undefined,
): () => void {
  SPAN_SOURCES.set(contextId, source);
  return () => {
    if (SPAN_SOURCES.get(contextId) === source) SPAN_SOURCES.delete(contextId);
  };
}

function hex(value: string, digits: number): string {
  const stripped = value.replace(/-/g, "").toLowerCase();
  if (
    stripped.length >= digits &&
    /^[0-9a-f]+$/.test(stripped.slice(0, digits))
  ) {
    const head = stripped.slice(0, digits);
    if (!ALL_ZERO.test(head)) return head;
  }
  return createHash("sha256").update(value).digest("hex").slice(0, digits);
}

/**
 * The trace context an outbound call from this exchange carries.
 *
 * The sending exchange is the one the call runs in, which names itself as
 * the remote's cause. An envelope built outside any route (a
 * `CraftClient.sendDirect`, an agent tool's dispatch) names nothing that
 * ran, so the cause it was built with stands in for it.
 *
 * @param exchange - The exchange making the call
 * @returns The two headers to send
 */
export function traceContextOf(exchange: Exchange): TraceContextCarrier {
  const contextId = getExchangeContext(exchange)?.contextId;
  const correlationId = exchange.headers[HeadersKeys.CORRELATION_ID];
  const cause = exchange.headers[HeadersKeys.CAUSATION_ID];
  const sender =
    getExchangeRoute(exchange) === undefined && typeof cause === "string"
      ? cause
      : exchange.id;
  return carrierFor(
    typeof correlationId === "string" ? correlationId : sender,
    sender,
    contextId,
  );
}

/**
 * The trace context a call carries when the caller holds the ids of the
 * exchange it runs for rather than the exchange itself: an agent's tool
 * handler, which sees its turn's correlation and exchange ids on the
 * handler context.
 *
 * @param ids - The calling exchange's correlation id and exchange id
 * @param contextId - Its context's id, which selects the telemetry plugin's live span
 * @returns The two headers to send
 */
export function traceContextFor(
  ids: { readonly correlationId?: string; readonly exchangeId: string },
  contextId?: string,
): TraceContextCarrier {
  return carrierFor(
    ids.correlationId ?? ids.exchangeId,
    ids.exchangeId,
    contextId,
  );
}

function carrierFor(
  correlation: string,
  sender: string,
  contextId: string | undefined,
): TraceContextCarrier {
  const span =
    contextId === undefined ? undefined : SPAN_SOURCES.get(contextId)?.(sender);
  const traceparent =
    span !== undefined &&
    /^[0-9a-f]{32}$/.test(span.traceId) &&
    /^[0-9a-f]{16}$/.test(span.spanId) &&
    !ALL_ZERO.test(span.traceId) &&
    !ALL_ZERO.test(span.spanId)
      ? `00-${span.traceId}-${span.spanId}-${(span.traceFlags & 0xff)
          .toString(16)
          .padStart(2, "0")}`
      : `00-${hex(correlation, 32)}-${hex(sender, 16)}-00`;
  // Each id rides only when it is in the alphabet a `tracestate` value
  // allows; the engine's own ids always are, so the fallback is for an id a
  // synthetic exchange made up.
  const fields = [
    ...(isTraceId(correlation) ? [`c:${correlation}`] : []),
    ...(isTraceId(sender) ? [`x:${sender}`] : []),
  ];
  const member =
    fields.length > 0 ? `rc=${fields.join(";")}` : `rc=x:${hex(sender, 32)}`;
  return { traceparent, tracestate: member };
}

/** What a door read from a request's trace context. */
export interface InboundTraceContext {
  /** The `traceparent` header, as received. */
  readonly traceparent?: string | null | undefined;
  /** The `tracestate` header, as received. */
  readonly tracestate?: string | null | undefined;
}

/** Headers to pass on `emit` so the exchange joins the caller's journey. */
export type AdoptedTraceHeaders = Readonly<Record<string, string>>;

function parseRcMember(tracestate: string): { c?: string; x?: string } {
  for (const raw of tracestate.split(",")) {
    const member = raw.trim();
    if (!member.startsWith("rc=")) continue;
    const out: { c?: string; x?: string } = {};
    for (const field of member.slice(3).split(";")) {
      const colon = field.indexOf(":");
      if (colon < 0) continue;
      const key = field.slice(0, colon);
      const value = field.slice(colon + 1);
      if ((key === "c" || key === "x") && isTraceId(value)) out[key] = value;
    }
    return out;
  }
  return {};
}

function asUuid(traceId: string): string {
  return `${traceId.slice(0, 8)}-${traceId.slice(8, 12)}-${traceId.slice(12, 16)}-${traceId.slice(16, 20)}-${traceId.slice(20)}`;
}

/**
 * Read an inbound trace context and return the headers a door passes on
 * `emit`, or an empty object when the context is absent, malformed, or not
 * adopted under `mode`.
 *
 * Adopted means: the correlation id from the `rc` member of `tracestate` when
 * present and well formed, else the `traceparent` trace id formatted as a
 * UUID; the causation id from the `rc` member, else none. A `traceparent`
 * that is malformed, version `ff`, or carries an all-zero id is ignored, as
 * W3C requires, and with it the whole context.
 *
 * @param inbound - The two headers as received
 * @param options - The mount's mode and whether the door verified a principal
 * @returns Headers for `emit`, possibly empty
 */
export function adoptTraceContext(
  inbound: InboundTraceContext,
  options: { mode?: TraceContextMode; authenticated: boolean },
): AdoptedTraceHeaders {
  const mode = options.mode ?? "authenticated";
  if (mode === "never") return {};
  if (mode === "authenticated" && !options.authenticated) return {};
  const traceparent =
    typeof inbound.traceparent === "string"
      ? inbound.traceparent.trim().toLowerCase()
      : undefined;
  if (traceparent === undefined) return {};
  const match = TRACEPARENT_PATTERN.exec(traceparent);
  if (match === null) return {};
  const [, version, traceId, parentId] = match as unknown as [
    string,
    string,
    string,
    string,
  ];
  if (version === "ff" || ALL_ZERO.test(traceId) || ALL_ZERO.test(parentId)) {
    return {};
  }
  // Version 00 has exactly four fields; a later version may append more.
  if (version === "00" && traceparent.length !== 55) return {};
  const rc =
    typeof inbound.tracestate === "string"
      ? parseRcMember(inbound.tracestate)
      : {};
  return {
    [HeadersKeys.CORRELATION_ID]: rc.c ?? asUuid(traceId),
    ...(rc.x !== undefined ? { [HeadersKeys.CAUSATION_ID]: rc.x } : {}),
    [TRACE_PARENT_HEADER]: traceparent.slice(0, 55),
  };
}
