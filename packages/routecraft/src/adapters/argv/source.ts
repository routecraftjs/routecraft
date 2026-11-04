import { isDropped } from "../../exchange";
import type { Source, Subscription } from "../../operations/from";
import { RUNNER_INVOCATION } from "../../context";
import { isDeferred } from "../../kernel/continuation/deferred";
import { callerRefusalOf } from "../../pipeline/caller-refusal";
import { rcCodeOf } from "../../brand";
import { renderDirectedJsonSchema } from "../../shared/standard-schema";
import type { RouteDefinition } from "../../route";
import { commandLineInput } from "./command-line";
import type { ArgvRouteHelp, RunnerInvocation, RunnerOutcome } from "./types";

/** Pinned so `--help` and the ops route detail describe a route alike. */
const JSON_SCHEMA_TARGET = "draft-2020-12";

const ARGV_ADAPTER_ID = "routecraft.adapter.argv";

/**
 * The ids of the routes in a context that read the command line with
 * `argv()`. Known before the context starts, so a runner can skip work for
 * a file with none, and refuse a file with more than one before anything
 * runs: one command line is one exchange for one route.
 *
 * @param context - Anything with the context's `getRoutes()`
 * @returns Route ids, in registration order
 */
export function argvRouteIds(context: {
  getRoutes(): readonly { definition: RouteDefinition }[];
}): string[] {
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
    const invocation = sub.context.getStore(RUNNER_INVOCATION) as
      RunnerInvocation | undefined;
    sub.ready();
    if (invocation === undefined) {
      sub.complete();
      return;
    }
    try {
      invocation.settle(await this.run(sub, invocation));
    } finally {
      sub.complete();
    }
  }

  private async run(
    sub: Subscription<unknown>,
    invocation: RunnerInvocation,
  ): Promise<RunnerOutcome> {
    const { routeId, discovery } = sub.meta;
    const readers = argvRouteIds(sub.context);
    if (readers.length > 1) {
      return {
        outcome: "usage",
        message: `Routes ${readers.map((id) => `"${id}"`).join(", ")} all read the command line with argv(). One invocation runs one route; keep argv() on one of them.`,
      };
    }

    const inputSchema = renderDirectedJsonSchema(
      discovery?.input?.body,
      "input",
      JSON_SCHEMA_TARGET,
    );
    const collisions = reservedCollisions(inputSchema, invocation.reserved);
    if (collisions.length > 0) {
      return {
        outcome: "usage",
        message: `Route "${routeId}" declares the input field(s) ${collisions.map((name) => `"${name}"`).join(", ")}, which the runner reads itself (${collisions.map((name) => `--${name}`).join(", ")}). Rename the field.`,
      };
    }

    if (invocation.help) {
      const help: ArgvRouteHelp = {
        id: routeId,
        ...(discovery?.title !== undefined ? { title: discovery.title } : {}),
        ...(discovery?.description !== undefined
          ? { description: discovery.description }
          : {}),
        ...(inputSchema !== undefined ? { input: inputSchema } : {}),
      };
      return { outcome: "help", route: help };
    }

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

/** The reserved names an input body schema declares as properties. */
function reservedCollisions(
  schema: unknown,
  reserved: readonly string[],
): string[] {
  if (schema === null || typeof schema !== "object") return [];
  const properties = (schema as { properties?: unknown }).properties;
  if (properties === null || typeof properties !== "object") return [];
  return reserved.filter((name) => Object.hasOwn(properties, name));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
