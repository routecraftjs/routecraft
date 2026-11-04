import { userInfo } from "node:os";
import { HeadersKeys, isDropped, type ExchangeHeaders } from "../../exchange";
import type { Source, Subscription } from "../../operations/from";
import { RUNNER_INVOCATION } from "../../context";
import { authorityOf } from "../../kernel/authority";
import { isDeferred } from "../../kernel/continuation/deferred";
import { callerRefusalOf } from "../../pipeline/caller-refusal";
import { rcCodeOf } from "../../brand";
import { renderDirectedJsonSchema } from "../../shared/standard-schema";
import type { Principal } from "../../principal";
import { commandLineInput } from "./command-line";
import type { ArgvRouteHelp, RunnerInvocation, RunnerOutcome } from "./types";

/**
 * Field names a route may not declare in its `.input()` body, because the
 * runner reads them itself after the file: `--help` and `--format`.
 *
 * @internal
 */
export const RESERVED_ARGV_FIELDS: readonly string[] = ["help", "format"];

/** Pinned so `--help` and the ops route detail describe a route alike. */
const JSON_SCHEMA_TARGET = "draft-2020-12";

/**
 * The route that claimed each invocation. One command line is one exchange
 * for one route: a second `argv()` route in the same file is a usage error,
 * not a second run of the same input.
 */
const claims = new WeakMap<RunnerInvocation, string>();

/**
 * ArgvSourceAdapter turns the runner's command line into one exchange.
 *
 * It is a door: it parses the arguments (or stdin) with the grammar
 * `craft exec` uses, mints the local operator principal through the
 * application's authority, emits one exchange through the full chain, and
 * reports how it ended to the runner. Rendering and the exit code are the
 * runner's, because the runner owns the process.
 */
export class ArgvSourceAdapter implements Source<unknown> {
  readonly adapterId = "routecraft.adapter.argv";

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
    const claimant = claims.get(invocation);
    if (claimant !== undefined && claimant !== routeId) {
      return {
        outcome: "usage",
        message: `Routes "${claimant}" and "${routeId}" both read the command line with argv(). One invocation runs one route; keep argv() on one of them.`,
      };
    }
    claims.set(invocation, routeId);

    const inputSchema = renderDirectedJsonSchema(
      discovery?.input?.body,
      "input",
      JSON_SCHEMA_TARGET,
    );
    const collisions = reservedCollisions(inputSchema);
    if (collisions.length > 0) {
      return {
        outcome: "usage",
        message: `Route "${routeId}" declares the input field(s) ${collisions.map((name) => `"${name}"`).join(", ")}, which the runner reserves after the file (--help, --format). Rename the field, or reach the route with craft exec.`,
      };
    }

    if (invocation.argv.includes("--help")) {
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

    const principal = authorityOf(sub.context).mint({
      kind: "local",
      scheme: "local",
      subject: localUser(),
      subjectProfile: "user",
      scopes: [...invocation.scopes],
    });

    try {
      const exchange = await sub.emit({
        message: input.body,
        headers: {
          [HeadersKeys.AUTH_PRINCIPAL]: principal,
        } as ExchangeHeaders,
      });
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
      return failureOutcome(error, routeId, principal);
    }
  }
}

function failureOutcome(
  error: unknown,
  routeId: string,
  principal: Principal,
): RunnerOutcome {
  if (rcCodeOf(error) === "RC5031") {
    return { outcome: "dropped", message: messageOf(error) };
  }
  const refusal = callerRefusalOf(error, {
    routeId,
    principal,
    credentialCouldHelp: false,
  });
  if (refusal !== undefined) return { outcome: "refused", refusal };
  return { outcome: "failed", message: messageOf(error) };
}

/** The reserved names an input body schema declares as properties. */
function reservedCollisions(schema: unknown): string[] {
  if (schema === null || typeof schema !== "object") return [];
  const properties = (schema as { properties?: unknown }).properties;
  if (properties === null || typeof properties !== "object") return [];
  return RESERVED_ARGV_FIELDS.filter((name) => Object.hasOwn(properties, name));
}

/** The OS account running the process, which is who the operator is. */
function localUser(): string {
  try {
    return userInfo().username || "local";
  } catch {
    // A container user with no passwd entry has no name to report.
    return "local";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
