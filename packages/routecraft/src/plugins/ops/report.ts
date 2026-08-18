/**
 * Turning ledger state into HTTP responses.
 *
 * The routing table is deliberately tiny and fully enumerated: five paths,
 * everything else 404. Keeping it here rather than in the plugin leaves the
 * plugin as wiring and makes the response contract unit-testable without
 * binding a port.
 */

import { jsonResponse } from "../http/response";
import type { HttpMountContext } from "../server/types";
import type { HealthLedger } from "./state";
import type {
  HealthComponent,
  HealthDetailsExposure,
  HealthReport,
  LivenessReport,
} from "./types";

export interface HealthHandlerOptions {
  state: HealthLedger;
  /** Exposure of per-component `details`. */
  details: HealthDetailsExposure;
  /**
   * Whether the server carrying this mount has a credential validator. With
   * none, `when-authenticated` has nothing to authenticate against and
   * collapses to `always`.
   */
  serverAuthConfigured: boolean;
  /** Process uptime in seconds, injectable for tests. */
  uptime: () => number;
}

/**
 * Whether `details` maps are served on this request.
 *
 * `when-authenticated` resolves the caller's credential through the mount's
 * effective validator. With no validator on the server there is nothing to
 * authenticate against, so it collapses to `always`, mirroring how the http
 * plugin collapses `/ready`'s `requireAuth`: a gate with nothing behind it
 * does not silently withhold. Verification runs only in that one mode, so a
 * probe against an open surface never pays for it.
 */
async function servesDetails(
  exposure: HealthDetailsExposure,
  serverAuthConfigured: boolean,
  context: HttpMountContext,
): Promise<boolean> {
  if (exposure === "never") return false;
  if (exposure === "always") return true;
  if (!serverAuthConfigured) return true;
  const result = await context.authenticate();
  return result?.kind === "admit";
}

/** Strip `details` from a component when the exposure gate is closed. */
function project(
  component: HealthComponent,
  withDetails: boolean,
): HealthComponent {
  if (withDetails) return component;
  return component.details === undefined
    ? component
    : {
        status: component.status,
        domain: component.domain,
        ...(component.ageMs !== undefined ? { ageMs: component.ageMs } : {}),
      };
}

/** Strip `details` from every component of a report. */
function projectReport(
  report: HealthReport,
  withDetails: boolean,
): HealthReport {
  if (withDetails) return report;
  const map = (
    components: Record<string, HealthComponent>,
  ): Record<string, HealthComponent> =>
    Object.fromEntries(
      Object.entries(components).map(([key, value]) => [
        key,
        project(value, false),
      ]),
    );
  return {
    view: report.view,
    status: report.status,
    context: project(report.context, false),
    routes: map(report.routes),
    indicators: map(report.indicators),
  };
}

/**
 * Percent-decode a path segment, or `undefined` when the escape is malformed.
 *
 * `decodeURIComponent` throws `URIError` on input like `%` or `%zz`, which any
 * caller can send. Returning `undefined` funnels those into the same 404 as an
 * unknown component.
 */
function decodeSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/** Resolve a per-component path to its component, or `undefined` if unknown. */
function resolveComponent(
  state: HealthLedger,
  pathname: string,
): HealthComponent | undefined {
  const routeId = /^\/health\/routes\/([^/]+)$/.exec(pathname)?.[1];
  if (routeId !== undefined) {
    const decoded = decodeSegment(routeId);
    return decoded === undefined ? undefined : state.routeComponentOf(decoded);
  }

  const indicator = /^\/health\/indicators\/([^/]+)$/.exec(pathname)?.[1];
  if (indicator !== undefined) {
    const decoded = decodeSegment(indicator);
    return decoded === undefined
      ? undefined
      : state.indicatorComponentOf(decoded);
  }

  return undefined;
}

/**
 * Build the ops request handler.
 *
 * Three signals, separated by what acting on each one does. The layout follows
 * MicroProfile Health (`/health`, `/health/live`, `/health/ready`, as
 * implemented by Quarkus, Helidon and Open Liberty) with Actuator's
 * per-component drill-down beneath the aggregate:
 *
 * - `GET /health`: operational health. Every component, whatever its domain.
 *   What an uptime monitor pages on. Never influences routing.
 * - `GET /health/live`: liveness. 200 while the process is up, and nothing
 *   else ever. Docker's HEALTHCHECK probes this, so no component may reach it:
 *   a third party going down would otherwise restart every replica in a loop.
 * - `GET /health/ready`: readiness. Whether this instance can serve right now,
 *   which is mostly its own lifecycle plus any instance-domain component.
 *   Consumed by reverse proxies and orchestrators.
 * - `GET /health/routes/<id>` and `GET /health/indicators/<name>`: one
 *   component with its own status code, for drill-down and targeted monitors.
 *   The `routes/` and `indicators/` prefixes keep component names from
 *   colliding with `live` and `ready` in the same path namespace.
 *
 * `/ops/*` is claimed by the same mount and answers 404 until the action
 * surface ships, so the paths cannot be taken by another surface in the
 * meantime. Every action there mutates and will require an authenticated
 * principal, which is the opposite posture to this read surface.
 */
export function createHealthHandler(
  options: HealthHandlerOptions,
): (req: Request, context: HttpMountContext) => Promise<Response> {
  const { state, details, serverAuthConfigured, uptime } = options;

  return async function handle(
    req: Request,
    context: HttpMountContext,
  ): Promise<Response> {
    const { pathname } = new URL(req.url);

    const known =
      pathname === "/health" ||
      pathname === "/health/live" ||
      pathname === "/health/ready" ||
      pathname.startsWith("/health/routes/") ||
      pathname.startsWith("/health/indicators/");

    if (!known) {
      return jsonResponse({ error: "not found" }, { status: 404 });
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response(null, {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }

    if (pathname === "/health/live") {
      const body: LivenessReport = { status: "up", uptime: uptime() };
      return jsonResponse(body, { status: 200 });
    }

    if (pathname === "/health" || pathname === "/health/ready") {
      const withDetails = await servesDetails(
        details,
        serverAuthConfigured,
        context,
      );
      const report = state.report(
        pathname === "/health/ready" ? "readiness" : "all",
      );
      return jsonResponse(projectReport(report, withDetails), {
        status: report.status === "down" ? 503 : 200,
      });
    }

    // Resolved before the gate: an unknown component answers 404 either way,
    // so verifying a credential first would be work whose outcome cannot
    // change the response.
    const component = resolveComponent(state, pathname);
    if (!component)
      return jsonResponse({ error: "not found" }, { status: 404 });
    const withDetails = await servesDetails(
      details,
      serverAuthConfigured,
      context,
    );
    return jsonResponse(project(component, withDetails), {
      status: component.status === "down" ? 503 : 200,
    });
  };
}
