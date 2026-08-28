/**
 * HTTP client for a running instance's ops server.
 *
 * Spans two surfaces that behave differently and must not be flattened.
 * `/health` never walls, so a probe with no credential works, and it
 * returns MORE when authenticated: per-component `details` are gated by
 * `health.details`. `/ops` answers by tier: 404 when a tier is off, open
 * when `true`, scope-checked when a scope string is configured.
 *
 * So this client presents a credential whenever the settings provide one,
 * on both surfaces, and degrades when none is. That is a correctness
 * requirement rather than a nicety: unauthenticated, a route component says
 * `degraded` and nothing else; authenticated, it says `degraded` because a
 * breaker is open. The bare status does not answer the question an operator
 * is asking.
 */

import type {
  HealthComponent,
  HealthReport,
  OpsDispatchOutcome,
  OpsPage,
  OpsRouteDetail,
  OpsRouteFilter,
  OpsRouteSummary,
} from "@routecraft/routecraft";
import { describeSource, type ResolvedSettings } from "./settings.js";
import { messageOf } from "./util.js";

/**
 * How long one request may take before the client gives up.
 *
 * A connection the instance accepts and then never answers is otherwise
 * indistinguishable from work in progress, and a CLI that hangs with no
 * output is the worst way for a read to fail. The abort lands in the same
 * catch as a refused connection, so it is reported as unreachable with the
 * address named.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/** Why a call did not produce an answer. Each needs a different remedy. */
export type OpsFailureKind =
  /** The instance could not be reached at all. */
  | "unreachable"
  /** The door refused: no credential, a bad one, or a missing scope. */
  | "refused"
  /** The tier is disabled, or the thing asked for does not exist. */
  | "absent"
  /** The instance answered, and the answer was an error. */
  | "error";

/** A call that did not produce an answer, with what to do about it. */
export class OpsClientError extends Error {
  constructor(
    readonly kind: OpsFailureKind,
    message: string,
    readonly status?: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "OpsClientError";
  }
}

/** A response body carrying the API's structured refusal or error. */
interface WireError {
  error?: string;
  reason?: string;
  scope?: string;
  code?: string;
  message?: string;
}

export interface OpsClient {
  /** Whether a credential is being presented, for rendering the view. */
  readonly authenticated: boolean;
  health(): Promise<HealthReport>;
  ready(): Promise<HealthReport>;
  routeHealth(id: string): Promise<HealthComponent>;
  indicatorHealth(name: string): Promise<HealthComponent>;
  listRoutes(filter?: OpsRouteFilter): Promise<OpsRouteSummary[]>;
  describeRoute(id: string): Promise<OpsRouteDetail>;
  dispatch(id: string, body: unknown): Promise<OpsDispatchOutcome>;
}

export function createOpsClient(settings: ResolvedSettings): OpsClient {
  const base = settings.url.value.replace(/\/+$/, "");
  const token = settings.token?.value;

  /**
   * Where the address came from, phrased for an error a reader must act
   * on. A wrong pinned address is otherwise indistinguishable from a
   * stopped instance.
   */
  const addressBlame = (): string =>
    `${base} (from the ${describeSource(settings.url)})`;

  async function call<T>(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      /**
       * Statuses whose body is an answer rather than an error. The health
       * surface replies 503 with a full report when a component is down, and
       * that is precisely the report an operator is asking for.
       */
      answeredBy?: readonly number[];
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
    }

    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method: init.method ?? "GET",
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch (error: unknown) {
      throw classifyTransportFailure(error, addressBlame());
    }

    // Inside its own guard: an abort part-way through the body is the same
    // class of failure as one during the request, and leaving it outside
    // turned a timeout into an unhandled rejection with a stack trace.
    let text: string;
    try {
      text = await response.text();
    } catch (error: unknown) {
      throw classifyTransportFailure(error, addressBlame());
    }
    const parsed: unknown = text.length === 0 ? undefined : parseJson(text);

    if (response.ok || (init.answeredBy?.includes(response.status) ?? false)) {
      // A 200 from something that is not this API (a wrong port, a proxy's
      // error page) would otherwise be cast to the caller's type and crash
      // in the renderer rather than here, where the address can be named.
      if (parsed === null || typeof parsed !== "object") {
        throw new OpsClientError(
          "error",
          `The instance at ${addressBlame()} answered ${String(response.status)} with a body this client does not recognise. Check that the address is a routecraft ops server.`,
          response.status,
        );
      }
      return parsed as T;
    }

    // A body that is not JSON still carries the reason on the error path: a
    // proxy's plain-text refusal names the thing that refused.
    const wire: WireError =
      parsed === null || typeof parsed !== "object"
        ? textAsWireError(text)
        : (parsed as WireError);
    if (response.status === 401 || response.status === 403) {
      throw new OpsClientError(
        "refused",
        refusalMessage(response.status, wire, token !== undefined),
        response.status,
        wire,
      );
    }
    if (response.status === 404) {
      throw new OpsClientError(
        "absent",
        wire.message ?? "not found",
        404,
        wire,
      );
    }
    throw new OpsClientError(
      "error",
      wire.message ?? describeWireError(wire, response.status),
      response.status,
      wire,
    );
  }

  /**
   * Render the door's own refusal rather than a summary of it. A missing
   * scope and a missing credential need opposite actions, and the server
   * already distinguishes them on the wire.
   */
  function refusalMessage(
    status: number,
    wire: WireError,
    presented: boolean,
  ): string {
    if (status === 403 && wire.reason === "insufficient_scope") {
      return `Refused: the credential does not carry the scope "${
        wire.scope ?? "(unnamed)"
      }". The identity is valid and the credential is not, so this needs a token carrying that scope rather than signing in again.`;
    }
    if (!presented) {
      return `Refused: this surface requires a credential and none was presented. Put a token in .routecraft/settings.yaml, set CRAFT_TOKEN, or pass --token.`;
    }
    return `Refused: the instance rejected the credential${
      wire.reason === undefined ? "" : ` (${wire.reason})`
    }.`;
  }

  // The health surface answers 503 with a complete report when something is
  // down. Treating that as a failure would blank the output at the one moment
  // the command exists for.
  const DOWN_IS_AN_ANSWER = { answeredBy: [503] } as const;

  return {
    authenticated: token !== undefined,

    health: () => call<HealthReport>("/health", DOWN_IS_AN_ANSWER),
    ready: () => call<HealthReport>("/health/ready", DOWN_IS_AN_ANSWER),
    routeHealth: (id: string) =>
      call<HealthComponent>(
        `/health/routes/${encodeURIComponent(id)}`,
        DOWN_IS_AN_ANSWER,
      ),
    indicatorHealth: (name: string) =>
      call<HealthComponent>(
        `/health/indicators/${encodeURIComponent(name)}`,
        DOWN_IS_AN_ANSWER,
      ),

    /**
     * Walk the whole collection rather than showing page one and stopping.
     *
     * The envelope's contract is that a present cursor means there is more,
     * and a client that ignores it silently reports a partial inventory as
     * a complete one. The cursor is replayed under the same filter it was
     * minted with, which is the only way the server will honour it.
     */
    async listRoutes(filter: OpsRouteFilter = {}): Promise<OpsRouteSummary[]> {
      // Serialised here, the one place that knows the wire, so no caller has
      // to spell a filter name as a string the compiler does not own.
      const query: Record<string, string> = {
        ...(filter.dispatchable !== undefined
          ? { dispatchable: String(filter.dispatchable) }
          : {}),
        ...(filter.id !== undefined ? { id: filter.id } : {}),
        ...(filter.source !== undefined ? { source: filter.source } : {}),
      };
      const items: OpsRouteSummary[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const params = new URLSearchParams(query);
        if (cursor !== undefined) params.set("after", cursor);
        const suffix = params.toString();
        const page = await call<OpsPage<OpsRouteSummary>>(
          `/ops/routes${suffix.length > 0 ? `?${suffix}` : ""}`,
        );
        items.push(...page.items);
        cursor = page.nextCursor;
        // The loop trusts the instance to advance, and this client talks to
        // instances it did not build: a repeated cursor would page forever and
        // grow `items` without bound. Refusing beats hanging, and beats
        // silently returning a listing with the same rows in it many times.
        if (cursor !== undefined && !seen.add(cursor)) {
          throw new OpsClientError(
            "error",
            "The instance repeated a pagination cursor, so the route listing cannot be completed. This is a fault in the instance rather than in the request.",
          );
        }
      } while (cursor !== undefined);
      return items;
    },

    describeRoute: (id: string) =>
      call<OpsRouteDetail>(`/ops/routes/${encodeURIComponent(id)}`),

    dispatch: (id: string, body: unknown) =>
      call<OpsDispatchOutcome>(
        `/ops/routes/${encodeURIComponent(id)}/exchanges`,
        { method: "POST", body: body ?? {} },
      ),
  };
}

/**
 * Parse a response body, or `undefined` when it is not JSON.
 *
 * Wrapping unparseable text in an object would let it through the
 * success guard, which only checks that the body is an object: a proxy
 * answering 200 with an HTML error page would then be handed to the caller
 * as a page whose `items` is missing, and the crash would land in the
 * renderer rather than here, where the address can be named.
 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Tell a request that never got an answer from one the instance refused to
 * answer in time.
 *
 * They need opposite reactions. "Could not reach it, start one" invites a
 * retry, which for a dispatch means running a possibly non-idempotent route a
 * second time while the first is still going.
 */
function classifyTransportFailure(
  error: unknown,
  address: string,
): OpsClientError {
  const aborted =
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError");
  if (aborted) {
    return new OpsClientError(
      "error",
      `The instance at ${address} accepted the request but did not answer within ${String(REQUEST_TIMEOUT_MS / 1000)}s. Any work it started is still running there, so do not simply re-run this.`,
    );
  }
  return new OpsClientError(
    "unreachable",
    `Could not reach a running instance at ${address}: ${messageOf(error)}\nStart one with 'craft start', or point at another instance with --url.`,
  );
}

/**
 * Describe an error body that carries no message.
 *
 * The framework's error code belongs to a bounded, documented vocabulary and
 * is safe to show, so it is shown: without it a route that refused the
 * caller's own credential (`RC5038`) is indistinguishable from one that
 * crashed, and the operator is told only that the instance answered 500.
 */
function describeWireError(wire: WireError, status: number): string {
  const answered = `The instance answered ${String(status)}`;
  if (wire.error === undefined && wire.code === undefined)
    return `${answered}.`;
  const parts = [wire.error, wire.code].filter(
    (part): part is string => part !== undefined,
  );
  return `${answered}: ${parts.join(" ")}. See https://routecraft.dev/docs/reference/errors for what the code means.`;
}

/** A non-JSON error body, carried as the reason so it still reaches the reader. */
function textAsWireError(text: string): WireError {
  const message = text.trim();
  return message.length > 0 ? { message } : {};
}
