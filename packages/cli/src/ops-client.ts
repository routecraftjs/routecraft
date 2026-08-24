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
  OpsRouteSummary,
} from "@routecraft/routecraft";
import { describeSource, type ResolvedSettings } from "./settings.js";

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
  listRoutes(query?: Record<string, string>): Promise<OpsRouteSummary[]>;
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
    init: { method?: string; body?: unknown } = {},
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
      throw new OpsClientError(
        "unreachable",
        `Could not reach a running instance at ${addressBlame()}: ${
          error instanceof Error ? error.message : String(error)
        }\nStart one with 'craft start', or point at another instance with --url.`,
      );
    }

    const text = await response.text();
    const parsed: unknown = text.length === 0 ? undefined : safeParse(text);

    if (response.ok) return parsed as T;

    const wire = (parsed ?? {}) as WireError;
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
      wire.message ?? `The instance answered ${String(response.status)}.`,
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

  return {
    authenticated: token !== undefined,

    health: () => call<HealthReport>("/health"),
    ready: () => call<HealthReport>("/health/ready"),
    routeHealth: (id: string) =>
      call<HealthComponent>(`/health/routes/${encodeURIComponent(id)}`),
    indicatorHealth: (name: string) =>
      call<HealthComponent>(`/health/indicators/${encodeURIComponent(name)}`),

    /**
     * Walk the whole collection rather than showing page one and stopping.
     *
     * The envelope's contract is that a present cursor means there is more,
     * and a client that ignores it silently reports a partial inventory as
     * a complete one. The cursor is replayed under the same filter it was
     * minted with, which is the only way the server will honour it.
     */
    async listRoutes(
      query: Record<string, string> = {},
    ): Promise<OpsRouteSummary[]> {
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

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}
