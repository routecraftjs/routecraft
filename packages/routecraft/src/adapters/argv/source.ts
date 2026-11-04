import { isDropped } from "../../exchange";
import type { Source, Subscription } from "../../operations/from";
import { RUNNER_INVOCATION } from "../../context";
import { isDeferred } from "../../kernel/continuation/deferred";
import { callerRefusalOf } from "../../pipeline/caller-refusal";
import { rcCodeOf } from "../../brand";
import {
  renderDirectedJsonSchema,
  ROUTE_SCHEMA_TARGET,
} from "../../shared/standard-schema";
import type { RouteDefinition } from "../../route";
import { commandLineInput } from "./command-line";
import type { ArgvRouteHelp, RunnerInvocation, RunnerOutcome } from "./types";

const ARGV_ADAPTER_ID = "routecraft.adapter.argv";

type RouteLookup = { getRoutes(): readonly { definition: RouteDefinition }[] };

/**
 * The ids of the routes in a context that read the command line with
 * `argv()`. Known before the context starts, so a runner can skip work for
 * a file with none. A runner refuses a file with more than one before it
 * starts the context: one command line is one exchange for one route, and
 * every `argv()` source reads the same invocation.
 *
 * @param context - Anything with the context's `getRoutes()`
 * @returns Route ids, in registration order
 */
export function argvRouteIds(context: RouteLookup): string[] {
  return context
    .getRoutes()
    .filter((route) =>
      route.definition.sources.some(
        (source) => source.adapterId === ARGV_ADAPTER_ID,
      ),
    )
    .map((route) => route.definition.id);
}

/**
 * What a runner's `--help` describes for one route: its id, title,
 * description, and its `.input()` body as JSON Schema. Read from the route
 * definition, so a runner answers `--help` without starting the context.
 *
 * `input` is absent when the route declares no body schema, or when the
 * schema library offers no JSON Schema rendering.
 *
 * @param context - Anything with the context's `getRoutes()`
 * @param routeId - The route to describe
 * @returns The description, or `undefined` for an unknown route id
 */
export function describeArgvRoute(
  context: RouteLookup,
  routeId: string,
): ArgvRouteHelp | undefined {
  const route = context
    .getRoutes()
    .find((candidate) => candidate.definition.id === routeId);
  if (route === undefined) return undefined;
  const { discovery } = route.definition;
  const input = renderDirectedJsonSchema(
    discovery?.input?.body,
    "input",
    ROUTE_SCHEMA_TARGET,
  );
  return {
    id: routeId,
    ...(discovery?.title !== undefined ? { title: discovery.title } : {}),
    ...(discovery?.description !== undefined
      ? { description: discovery.description }
      : {}),
    ...(input !== undefined ? { input } : {}),
  };
}

/**
 * ArgvSourceAdapter turns the runner's command line into one exchange.
 *
 * It is a door: it parses the arguments (or stdin) with the grammar
 * `craft exec` uses, emits one exchange through the full chain, and reports
 * how it ended to the runner.
 *
 * It puts no principal on the exchange: a command line proves no identity.
 * A route with `.authorize()` therefore fails unless a plugin supplies a
 * principal on the way in. Rendering and the exit code are the
 * runner's, because the runner owns the process.
 */
export class ArgvSourceAdapter implements Source<unknown> {
  readonly adapterId = ARGV_ADAPTER_ID;

  async subscribe(sub: Subscription<unknown>): Promise<void> {
    const invocation = sub.context.getStore(RUNNER_INVOCATION);
    sub.ready();
    if (invocation === undefined) {
      sub.complete();
      return;
    }
    try {
      invocation.settle(await this.run(sub, invocation));
    } catch (error: unknown) {
      // Settled so the runner reports a failure rather than a silent exit 0.
      invocation.settle({ outcome: "failed", message: messageOf(error) });
    } finally {
      sub.complete();
    }
  }

  private async run(
    sub: Subscription<unknown>,
    invocation: RunnerInvocation,
  ): Promise<RunnerOutcome> {
    const { routeId } = sub.meta;
    const stdin =
      invocation.argv.length === 0 ? await invocation.readStdin() : undefined;
    const input = commandLineInput(invocation.argv, stdin);
    if ("error" in input) return { outcome: "usage", message: input.error };

    try {
      const exchange = await sub.emit({ message: input.body });
      if (isDropped(exchange)) {
        return {
          outcome: "dropped",
          message: `Route "${routeId}" filtered the exchange out before it produced a result.`,
        };
      }
      if (isDeferred(exchange.body)) {
        return { outcome: "deferred", deferral: exchange.body };
      }
      return { outcome: "completed", body: exchange.body };
    } catch (error: unknown) {
      return failureOutcome(error, routeId);
    }
  }
}

function failureOutcome(error: unknown, routeId: string): RunnerOutcome {
  if (rcCodeOf(error) === "RC5031") {
    return { outcome: "dropped", message: messageOf(error) };
  }
  const refusal = callerRefusalOf(error, {
    routeId,
    principal: undefined,
    credentialCouldHelp: false,
  });
  if (refusal !== undefined) return { outcome: "refused", refusal };
  return { outcome: "failed", message: messageOf(error) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
