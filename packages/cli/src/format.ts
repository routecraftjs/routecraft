/**
 * Rendering for `craft exec` and the `craft ops` family.
 *
 * Three formats, one meaning each. `pretty` is the default because the
 * commands are read by a person at a terminal far more often than they are
 * piped; `json` is the whole structured answer for a script; `raw` is the
 * bare payload with no envelope, so `craft exec greet --name=x | jq` works
 * without the caller unwrapping anything first.
 */

import type {
  HealthComponent,
  HealthReport,
  OpsDispatchOutcome,
  OpsRouteDetail,
  OpsRouteSummary,
} from "@routecraft/routecraft";
import type { OutputFormat } from "./settings.js";

/** Serialise a whole structured answer. */
export function asJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * The bare payload for `raw`.
 *
 * A string is printed as itself rather than as a quoted JSON string: the
 * point of `raw` is that the next program in the pipe reads the value, and
 * a shell reading `"hello"` with the quotes has to strip them.
 */
export function asRaw(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Render a dispatch outcome. */
export function renderDispatch(
  outcome: OpsDispatchOutcome,
  format: OutputFormat,
): string {
  if (format === "json") return asJson(outcome);
  if (format === "raw") {
    if (outcome.outcome === "completed") return asRaw(outcome.body);
    if (outcome.outcome === "suspended") return asJson(outcome.suspension);
    return asRaw(outcome.message);
  }

  if (outcome.outcome === "completed") return prettyValue(outcome.body);
  if (outcome.outcome === "dropped") {
    // Named as a drop rather than a failure. A filter said no and there is
    // no response body, which is a different thing to go and look at from a
    // step that broke.
    return `Dropped: the route filtered this exchange out before it produced a result.\n${outcome.message}`;
  }

  const { suspension } = outcome;
  const lines = [
    "Suspended: the route parked this exchange and will finish it when it is resumed.",
    `  suspension  ${suspension.suspensionId}`,
    `  token       ${suspension.token}`,
  ];
  if (suspension.expiresAt !== undefined) {
    lines.push(`  expires     ${suspension.expiresAt}`);
  }
  lines.push(
    "",
    "Resume it through the route the app exposes for that; the token is single-use and the framework mints no resume door of its own.",
  );
  return lines.join("\n");
}

/** Render the route collection. */
export function renderRoutes(
  routes: readonly OpsRouteSummary[],
  format: OutputFormat,
): string {
  if (format === "json") return asJson({ items: routes });
  if (format === "raw") {
    return routes.map((route) => route.id).join("\n");
  }
  if (routes.length === 0) return "No routes.";

  const rows = routes.map((route) => [
    route.id,
    route.dispatchable ? "yes" : "no",
    route.sources.join(", "),
    route.title ?? route.description ?? "",
  ]);
  return table(["ROUTE", "DISPATCHABLE", "SOURCES", ""], rows);
}

/** Render one route, optionally alongside its health component. */
export function renderRouteDetail(
  route: OpsRouteDetail | undefined,
  health: HealthComponent | undefined,
  format: OutputFormat,
  view: ViewNote,
): string {
  const combined = {
    ...(route !== undefined ? { definition: route } : {}),
    ...(health !== undefined ? { health } : {}),
  };
  if (format === "json") return asJson(combined);
  if (format === "raw") return asJson(combined);

  const lines: string[] = [];
  if (route !== undefined) {
    lines.push(`Route        ${route.id}`);
    if (route.title !== undefined) lines.push(`Title        ${route.title}`);
    if (route.description !== undefined) {
      lines.push(`Description  ${route.description}`);
    }
    lines.push(`Dispatchable ${route.dispatchable ? "yes" : "no"}`);
    lines.push(`Sources      ${route.sources.join(", ")}`);
    if (route.requiresPrincipal) {
      lines.push(`Authorize    route entry requires a principal`);
    }
    if (route.tags !== undefined) {
      lines.push(`Tags         ${route.tags.join(", ")}`);
    }
    if (route.input?.body !== undefined) {
      lines.push("", "Input schema", indent(asJson(route.input.body)));
    }
  }
  if (health !== undefined) {
    if (lines.length > 0) lines.push("");
    lines.push("Health", indent(renderComponent(health)));
  }
  lines.push("", viewNote(view));
  return lines.join("\n");
}

/** Render a health report. */
export function renderReport(
  report: HealthReport,
  format: OutputFormat,
  view: ViewNote,
): string {
  if (format === "json") return asJson(report);
  if (format === "raw") return report.status;

  const lines = [
    `Status   ${report.status}`,
    `View     ${report.view}`,
    "",
    `context  ${componentLine(report.context)}`,
  ];
  const routes = Object.entries(report.routes);
  if (routes.length > 0) {
    lines.push("", "Routes");
    for (const [id, component] of routes) {
      lines.push(`  ${id}  ${componentLine(component)}`);
    }
  }
  const indicators = Object.entries(report.indicators);
  if (indicators.length > 0) {
    lines.push("", "Indicators");
    for (const [name, component] of indicators) {
      lines.push(`  ${name}  ${componentLine(component)}`);
    }
  }
  lines.push("", viewNote(view));
  return lines.join("\n");
}

/** Render the indicator map lifted off the aggregate report. */
export function renderIndicators(
  indicators: Record<string, HealthComponent>,
  format: OutputFormat,
  view: ViewNote,
): string {
  if (format === "json") return asJson(indicators);
  if (format === "raw") {
    return Object.keys(indicators).join("\n");
  }
  const entries = Object.entries(indicators);
  if (entries.length === 0) return "No indicators are registered.";
  const lines = entries.map(
    ([name, component]) => `${name}  ${componentLine(component)}`,
  );
  lines.push(
    "",
    "Read from the indicators map on the health report; there is no separate indicator collection.",
    viewNote(view),
  );
  return lines.join("\n");
}

/** Render one health component. */
export function renderComponent(
  component: HealthComponent,
  format: OutputFormat = "pretty",
  view?: ViewNote,
): string {
  if (format === "json") return asJson(component);
  if (format === "raw") return component.status;
  const lines = [componentLine(component)];
  if (view !== undefined) lines.push("", viewNote(view));
  return lines.join("\n");
}

function componentLine(component: HealthComponent): string {
  const parts = [component.status, `(${component.domain})`];
  if (component.ageMs !== undefined) {
    parts.push(`age ${String(component.ageMs)}ms`);
  }
  if (component.details !== undefined) {
    const details = Object.entries(component.details)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(" ");
    if (details.length > 0) parts.push(details);
  }
  return parts.join(" ");
}

/** Whether a credential was presented, so the reader knows which view this is. */
export type ViewNote = "authenticated" | "anonymous";

/**
 * Say which view the reader is looking at.
 *
 * The unauthenticated answer is a thinner answer, not an error, and the
 * difference is invisible from the output alone: a component says
 * `degraded` either way, and only the authenticated view says `degraded`
 * because a breaker is open. Rendering a status with no reason and no note
 * would leave an operator believing they had the whole picture.
 */
function viewNote(view: ViewNote): string {
  return view === "authenticated"
    ? "Authenticated view: per-component details included where the instance exposes them."
    : "Anonymous view: statuses only. Per-component details are withheld from callers with no credential; present one to see why a component is in the state it reports.";
}

function prettyValue(value: unknown): string {
  if (value === undefined) return "(no result body)";
  return typeof value === "string" ? value : asJson(value);
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

/** Fixed-width columns, padded to the widest cell. */
function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const render = (cells: string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();
  return [render(headers), ...rows.map(render)].join("\n");
}
