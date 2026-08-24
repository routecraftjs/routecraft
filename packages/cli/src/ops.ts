/**
 * `craft ops`: the operator-facing read commands over a running instance.
 *
 * The split across the family is by intent, not by URL. `craft exec` runs
 * work; `craft ops` inspects the instance itself. That is why `craft ops
 * health` reads `/health/**`, which is deliberately NOT under `/ops`: health
 * never walls so an orchestrator probe works without a credential, while
 * `/ops` answers by tier, and separate prefixes make "expose health, never
 * expose ops" a rule that is hard to get wrong at an ingress. The command
 * family and the path layout answer different questions and are allowed to
 * differ.
 */

import type { HealthComponent, OpsRouteDetail } from "@routecraft/routecraft";
import {
  createOpsClient,
  OpsClientError,
  type OpsClient,
} from "./ops-client.js";
import {
  renderComponent,
  renderIndicators,
  renderReport,
  renderRouteDetail,
  renderRoutes,
  type ViewNote,
} from "./format.js";
import { EXEC_EXIT, type ExecResult } from "./exec.js";
import {
  resolveSettings,
  SettingsError,
  type SettingsOverrides,
} from "./settings.js";

/** Filters accepted by `craft ops routes`. */
export interface OpsRoutesOptions extends SettingsOverrides {
  dispatchable?: boolean;
  source?: string;
}

function failureCode(error: OpsClientError): number {
  if (error.kind === "unreachable") return EXEC_EXIT.unreachable;
  if (error.kind === "refused" || error.kind === "absent") {
    return EXEC_EXIT.refused;
  }
  return EXEC_EXIT.failed;
}

/** Set up a client, or report why the settings could not be resolved. */
function prepare(overrides: SettingsOverrides):
  | {
      ok: true;
      client: OpsClient;
      format: ReturnType<typeof resolveSettings>["format"]["value"];
      view: ViewNote;
    }
  | { ok: false; result: ExecResult } {
  let settings;
  try {
    settings = resolveSettings(overrides);
  } catch (error: unknown) {
    if (error instanceof SettingsError) {
      return {
        ok: false,
        result: { code: EXEC_EXIT.usage, error: error.message },
      };
    }
    throw error;
  }
  const client = createOpsClient(settings);
  return {
    ok: true,
    client,
    format: settings.format.value,
    view: client.authenticated ? "authenticated" : "anonymous",
  };
}

/** Run one read and render it, turning client failures into exit codes. */
async function read(
  overrides: SettingsOverrides,
  run: (
    client: OpsClient,
    format: ReturnType<typeof resolveSettings>["format"]["value"],
    view: ViewNote,
  ) => Promise<string>,
): Promise<ExecResult> {
  const prepared = prepare(overrides);
  if (!prepared.ok) return prepared.result;
  try {
    return {
      code: EXEC_EXIT.ok,
      output: await run(prepared.client, prepared.format, prepared.view),
    };
  } catch (error: unknown) {
    if (!(error instanceof OpsClientError)) throw error;
    return { code: failureCode(error), error: error.message };
  }
}

/** `craft ops health`: the operational aggregate, never a routing signal. */
export function healthCommand(
  overrides: SettingsOverrides = {},
): Promise<ExecResult> {
  return read(overrides, async (client, format, view) =>
    renderReport(await client.health(), format, view),
  );
}

/**
 * `craft ops ready`: whether this replica should receive traffic.
 *
 * Its own command rather than a flag on `health`, because it answers a
 * different question for a different consumer. The report carries `view`
 * precisely so the two are not confused, and a flag would invite reading
 * the routing signal when the operational one was meant.
 */
export function readyCommand(
  overrides: SettingsOverrides = {},
): Promise<ExecResult> {
  return read(overrides, async (client, format, view) =>
    renderReport(await client.ready(), format, view),
  );
}

/** `craft ops routes`: the instance's route inventory. */
export function routesCommand(
  options: OpsRoutesOptions = {},
): Promise<ExecResult> {
  return read(options, async (client, format) => {
    const query: Record<string, string> = {};
    if (options.dispatchable !== undefined) {
      query["dispatchable"] = String(options.dispatchable);
    }
    if (options.source !== undefined) query["source"] = options.source;
    return renderRoutes(await client.listRoutes(query), format);
  });
}

/**
 * `craft ops routes <id>`: one route, definition and health together.
 *
 * Merged rather than split across two subcommands, because "tell me about
 * this route" is one operator question and two answers would leave the
 * reader having to know which half carries the field they want. When the
 * introspection tier refuses, the health half is still served and the
 * output says the definition is missing rather than failing outright: a
 * thinner answer beats no answer for a question about a route that is
 * misbehaving right now.
 */
export function routeCommand(
  id: string,
  options: SettingsOverrides = {},
): Promise<ExecResult> {
  return read(options, async (client, format, view) => {
    const [definition, health] = await Promise.all([
      optional(() => client.describeRoute(id)),
      optional(() => client.routeHealth(id)),
    ]);
    if (definition === undefined && health === undefined) {
      throw new OpsClientError(
        "absent",
        `No route "${id}" was readable on this instance. Either no route by that id is registered, or the introspection tier is disabled and health has nothing for it either.`,
      );
    }
    return renderRouteDetail(
      definition as OpsRouteDetail | undefined,
      health as HealthComponent | undefined,
      format,
      view,
    );
  });
}

/**
 * `craft ops indicators`: the indicator map, lifted off the aggregate.
 *
 * There is no indicator collection endpoint; the map on `GET /health` is
 * the source. The rendering says so rather than implying a resource that
 * does not exist.
 */
export function indicatorsCommand(
  overrides: SettingsOverrides = {},
): Promise<ExecResult> {
  return read(overrides, async (client, format, view) =>
    renderIndicators((await client.health()).indicators, format, view),
  );
}

/** `craft ops indicators <name>`: one indicator's component. */
export function indicatorCommand(
  name: string,
  overrides: SettingsOverrides = {},
): Promise<ExecResult> {
  return read(overrides, async (client, format, view) =>
    renderComponent(await client.indicatorHealth(name), format, view),
  );
}

/**
 * Run a read that is allowed to come back empty.
 *
 * Only a refusal or an absence degrades to `undefined`; an unreachable
 * instance still propagates, because "half the answer" is misleading when
 * there was never a connection to get the other half from.
 */
async function optional<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (error: unknown) {
    if (
      error instanceof OpsClientError &&
      (error.kind === "refused" || error.kind === "absent")
    ) {
      return undefined;
    }
    throw error;
  }
}
