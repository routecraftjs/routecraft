/**
 * Carrying a journey across a door: W3C Trace Context on the wire, mapped to
 * and from Routecraft's correlation and causation ids.
 *
 * Two headers cross the wire, `traceparent` and `tracestate`:
 *
 * - `traceparent` is the standard one, so an OpenTelemetry service on the
 *   other side parents its spans correctly. With a telemetry plugin
 *   providing {@link TRACE_SPANS}, its trace and parent ids are the current
 *   exchange span's. Without one, the trace id derives from the correlation
 *   id and the parent id from the exchange id.
 * - `tracestate` carries one member, `rc=c:<correlation>;x:<exchange>`: the
 *   exact Routecraft ids, so a Routecraft peer keeps the correlation string
 *   and records causation without guessing from the lossy `traceparent`
 *   fields. Members other vendors sent inbound are not forwarded: the
 *   outbound call is a new span of this process, not a relay of the inbound
 *   one.
 *
 * Correlation is an observability claim, never authority. A caller who can
 * attach its requests to another journey could pollute that journey's
 * record, which is why a door adopts an inbound context only under
 * {@link TraceContextMode}, and an exchange that adopted one (or was
 * re-stamped by `.correlate()`, or reacts through `event()`) is marked as
 * having joined its journey ({@link isJoinedJourney}), so nothing that
 * resolves a particular person by correlation id trusts it.
 */
import { createHash } from "node:crypto";
import { rcError } from "./error.ts";
import {
  HeadersKeys,
  getExchangeContext,
  getExchangeRoute,
  type Exchange,
} from "./exchange.ts";
import { port } from "./kernel/port.ts";
import { existingLineageOf } from "./lineage.ts";
import { JOINED_HEADER, TRACE_PARENT_HEADER } from "./journey-headers.ts";

export { JOINED_HEADER, TRACE_PARENT_HEADER };
import type { CraftContext } from "./context.ts";

/** The modes a door's `traceContext` option accepts, in one place. */
export const TRACE_CONTEXT_MODES = [
  "authenticated",
  "always",
  "never",
] as const;

/**
 * Whether a door adopts an inbound trace context.
 *
 * - `"authenticated"` (the default): only when the door verified a principal
 *   for the request.
 * - `"always"`: from any caller, for a mount whose callers are all trusted
 *   (an internal network, a gateway that authenticates in front).
 * - `"never"`: every inbound request starts a new chain.
 */
export type TraceContextMode = (typeof TRACE_CONTEXT_MODES)[number];

/**
 * Whether a configured value is a {@link TraceContextMode}, for a plugin's
 * option validation.
 *
 * @param value - The configured value
 */
export function isTraceContextMode(value: unknown): value is TraceContextMode {
  return (TRACE_CONTEXT_MODES as readonly unknown[]).includes(value);
}

/** The two W3C Trace Context headers, as they cross the wire. */
export interface TraceContextCarrier {
  /** `00-<trace-id>-<parent-id>-<flags>` */
  readonly traceparent: string;
  /** `rc=c:<correlation id>;x:<exchange id>` */
  readonly tracestate: string;
}

/**
 * The longest correlation or causation id the engine accepts from outside it
 * (a door, `.correlate()`, a source).
 */
export const MAX_TRACE_ID_LENGTH = 128;

/** The longest value W3C allows one `tracestate` member. */
const MAX_TRACESTATE_VALUE = 256;

const TRACE_ID_PATTERN = /^[A-Za-z0-9._~:-]+$/;
const TRACEPARENT_PATTERN =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;
const ALL_ZERO = /^0+$/;

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

/**
 * Whether an exchange joined its journey rather than being called into it:
 * its correlation id was adopted at a door, re-stamped by `.correlate()`, or
 * continued by an `event()` delivery, by it or by an in-process exchange it
 * descends from. Such a correlation id is a claim another party could make,
 * so code that reaches a particular person or session by correlation id (the
 * ACP surface's turn table) does not resolve it for a joined exchange.
 *
 * @param exchange - The exchange to test
 * @returns Whether its correlation id is a claim rather than an inheritance
 */
export function isJoinedJourney(exchange: Exchange): boolean {
  if (exchange.headers[JOINED_HEADER] !== undefined) return true;
  const context = getExchangeContext(exchange);
  if (context === undefined) return false;
  return existingLineageOf(context)?.get(exchange.id)?.joined === true;
}

/** A span, as the wire needs it. */
export interface SpanContextLike {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
}

/** What a telemetry plugin offers outbound calls: the live span of an exchange. */
export interface TraceSpans {
  /**
   * The live span of an in-flight exchange, or undefined when the plugin
   * holds none for it.
   *
   * @param exchangeId - The exchange making an outbound call
   */
  spanOf(exchangeId: string): SpanContextLike | undefined;
}

/**
 * Port a telemetry plugin provides so an outbound `traceparent` names the
 * span of the exchange making the call. The shipped `telemetry()` plugin
 * provides it; a replacement OpenTelemetry plugin provides it the same way.
 * With no provider the `traceparent` derives from the journey's ids.
 */
export const TRACE_SPANS = port<TraceSpans>("routecraft.trace.spans@1");

/**
 * A `traceparent` value parsed as W3C reads it: version `ff`, an all-zero id,
 * or a malformed field is rejected; version `00` has exactly four fields,
 * and a later version is read by its known prefix.
 *
 * @param value - The header value
 * @returns The span it names, or undefined when it is not valid
 * @internal
 */
export function parseTraceparent(value: string): SpanContextLike | undefined {
  const normalized = value.trim().toLowerCase();
  const match = TRACEPARENT_PATTERN.exec(normalized);
  if (match === null) return undefined;
  const [, version, traceId, spanId, flags, rest] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string | undefined,
  ];
  if (version === "ff" || ALL_ZERO.test(traceId) || ALL_ZERO.test(spanId)) {
    return undefined;
  }
  if (version === "00" && rest !== undefined) return undefined;
  return { traceId, spanId, traceFlags: Number.parseInt(flags, 16) };
}

function formatTraceparent(span: SpanContextLike): string {
  return `00-${span.traceId}-${span.spanId}-${(span.traceFlags & 0xff)
    .toString(16)
    .padStart(2, "0")}`;
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
  const correlationId = exchange.headers[HeadersKeys.CORRELATION_ID];
  const cause = exchange.headers[HeadersKeys.CAUSATION_ID];
  const sender =
    getExchangeRoute(exchange) === undefined && typeof cause === "string"
      ? cause
      : exchange.id;
  return carrierFor(
    typeof correlationId === "string" ? correlationId : sender,
    sender,
    getExchangeContext(exchange),
  );
}

/**
 * The application's say over the trace context its outbound clients send,
 * set once as `traceContext` in the config.
 */
export interface TraceContextConfig {
  /**
   * Whether the `http()` client, the MCP clients and the remotes channel
   * send `traceparent` and `tracestate` when nothing more specific says.
   * `false` keeps journey ids from every third party at once; a call's own
   * `traceContext`, then its MCP client's or remote's, still wins. Defaults
   * to `true`. Inbound adoption is each door's own option.
   */
  readonly outbound?: boolean;
}

/**
 * Whether an outbound call sends its trace context: the first setting that
 * says, most specific first (the call's own `traceContext`, then its MCP
 * client's or remote's), else the context's `traceContext.outbound`, else
 * yes.
 *
 * @param context - The calling exchange's context, if it has one
 * @param settings - The call's own settings, most specific first
 */
export function sendsTraceContext(
  context: CraftContext | undefined,
  ...settings: ReadonlyArray<boolean | undefined>
): boolean {
  for (const setting of settings) {
    if (setting !== undefined) return setting;
  }
  return context?.outboundTraceContext ?? true;
}

/**
 * The trace context a call carries when the caller holds the ids of the
 * exchange it runs for rather than the exchange itself: an agent's tool
 * handler, which sees its turn's correlation and exchange ids on the
 * handler context.
 *
 * @param ids - The calling exchange's correlation id and exchange id
 * @param context - Its context, which may provide {@link TRACE_SPANS}
 * @returns The two headers to send
 */
export function traceContextFor(
  ids: {
    readonly correlationId?: string | undefined;
    readonly exchangeId: string;
  },
  context?: CraftContext,
): TraceContextCarrier {
  return carrierFor(
    ids.correlationId ?? ids.exchangeId,
    ids.exchangeId,
    context,
  );
}

function carrierFor(
  correlation: string,
  sender: string,
  context: CraftContext | undefined,
): TraceContextCarrier {
  const live = context?.lookup(TRACE_SPANS)?.spanOf(sender);
  const span =
    live !== undefined &&
    /^[0-9a-f]{32}$/.test(live.traceId) &&
    /^[0-9a-f]{16}$/.test(live.spanId) &&
    !ALL_ZERO.test(live.traceId) &&
    !ALL_ZERO.test(live.spanId)
      ? live
      : undefined;
  const traceparent =
    span !== undefined
      ? formatTraceparent(span)
      : `00-${hex(correlation, 32)}-${hex(sender, 16)}-00`;
  return { traceparent, tracestate: rcMember(correlation, sender) };
}

/**
 * The `rc` member: each id rides only when it is in the alphabet a
 * `tracestate` value allows (the engine's own ids always are), and the
 * exchange id is left off when both together would pass the 256-character
 * value limit, since the correlation id is the one a peer cannot recover.
 */
function rcMember(correlation: string, sender: string): string {
  const c = isTraceId(correlation) ? `c:${correlation}` : undefined;
  const x = isTraceId(sender) ? `x:${sender}` : undefined;
  if (c !== undefined && x !== undefined) {
    const both = `${c};${x}`;
    return `rc=${both.length <= MAX_TRACESTATE_VALUE ? both : c}`;
  }
  const one = c ?? x;
  return one !== undefined ? `rc=${one}` : `rc=x:${hex(sender, 32)}`;
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
 * UUID; the causation id from the `rc` member, else none; the exchange
 * marked as having joined its journey at a door. A `traceparent` that is not
 * valid ({@link parseTraceparent}) is ignored, as W3C requires, and with it
 * the whole context.
 *
 * @param inbound - The two headers as received
 * @param options - The mount's mode and whether the door verified a principal
 * @returns Headers for `emit`, possibly empty
 */
export function adoptTraceContext(
  inbound: InboundTraceContext,
  options: { mode?: TraceContextMode | undefined; authenticated: boolean },
): AdoptedTraceHeaders {
  const mode = options.mode ?? "authenticated";
  if (mode === "never") return {};
  // Only "always" skips the principal check, so a mode no caller validated
  // falls back to the authenticated rule rather than to adoption.
  if (mode !== "always" && !options.authenticated) return {};
  if (typeof inbound.traceparent !== "string") return {};
  const parent = parseTraceparent(inbound.traceparent);
  if (parent === undefined) return {};
  const rc =
    typeof inbound.tracestate === "string"
      ? parseRcMember(inbound.tracestate)
      : {};
  return {
    [HeadersKeys.CORRELATION_ID]: rc.c ?? asUuid(parent.traceId),
    ...(rc.x !== undefined ? { [HeadersKeys.CAUSATION_ID]: rc.x } : {}),
    [TRACE_PARENT_HEADER]: formatTraceparent(parent),
    [JOINED_HEADER]: "door",
  };
}
