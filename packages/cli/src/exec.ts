/**
 * `craft exec`: dispatch to a route on a running instance and print what
 * came back.
 *
 * The generic invoke-an-endpoint primitive, scriptable and composable. It
 * reaches an agent only through a route the app wrote, which is what gives
 * that path the app's own guardrails: the full pre-from chain runs, so
 * `.authorize()`, `.input()` and `.throttle()` all apply per message. That
 * is a property worth relying on rather than an accident of the plumbing.
 */

import {
  createOpsClient,
  OpsClientError,
  type OpsClient,
} from "./ops-client.js";
import { renderDispatch, renderRoutes, asJson } from "./format.js";
import {
  describeSource,
  resolveSettings,
  SettingsError,
  type SettingsOverrides,
} from "./settings.js";

/**
 * Exit codes, which are the API for anything scripting this.
 *
 * A suspension shares `ok` with a completion because both mean the
 * instance accepted and answered; a park is an outcome, not a fault. A
 * refusal is separate from a failure because they need opposite actions:
 * one is about the credential, the other about the route.
 */
export const EXEC_EXIT = {
  ok: 0,
  /** The route failed, or dropped the exchange. */
  failed: 1,
  /** The command was used incorrectly. */
  usage: 2,
  /** No instance could be reached. */
  unreachable: 3,
  /** The door refused: missing credential, bad credential, missing scope. */
  refused: 4,
} as const;

export interface ExecResult {
  code: number;
  /** Written to stdout. */
  output?: string;
  /** Written to stderr. */
  error?: string;
}

export interface ExecOptions extends SettingsOverrides {
  /** Body read from a pipe, when stdin was not a terminal. */
  stdin?: string;
}

/**
 * Turn trailing `--flag=value` arguments into a request body.
 *
 * Flat and predictable on purpose: a bare flag is `true`, a repeated flag
 * becomes an array, and everything else is the string the shell passed.
 * Nothing is coerced to a number, because a route that wants one declares
 * it with `.input()` and a CLI guessing types is a source of bugs that only
 * appear for values that look numeric.
 *
 * Anything richer than that goes in on stdin as JSON.
 */
export function bodyFromArgs(args: readonly string[]): {
  body: Record<string, unknown>;
  error?: string;
} {
  const body: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      return {
        body,
        error: `Unexpected argument "${arg}". Route input is passed as --field=value pairs, or as JSON on stdin.`,
      };
    }
    const withoutDashes = arg.slice(2);
    const equals = withoutDashes.indexOf("=");
    let key: string;
    let value: unknown;
    if (equals >= 0) {
      key = withoutDashes.slice(0, equals);
      value = withoutDashes.slice(equals + 1);
    } else {
      key = withoutDashes;
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        index += 1;
      } else {
        value = true;
      }
    }
    if (key === "") {
      return { body, error: `"${arg}" is not a valid field name.` };
    }
    const existing = body[key];
    if (existing === undefined) {
      body[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      body[key] = [existing, value];
    }
  }
  return { body };
}

/**
 * List what this instance can be asked to run.
 *
 * A tier refusal is rendered as the refusal it is rather than swallowed
 * into an empty list: "this instance exposes nothing" and "your credential
 * may not read the inventory" call for different actions, and an empty list
 * posing as an answer would send the reader after the wrong one.
 */
async function introspect(
  client: OpsClient,
  format: Parameters<typeof renderRoutes>[1],
): Promise<ExecResult> {
  const staticHelp = [
    "Usage: craft exec [options] <route> [--field=value ...]",
    "",
    "Options:",
    "  --url <url>        Instance ops server (default: the settings file, else http://127.0.0.1:8080)",
    "  --token <token>    Bearer credential presented at the management door",
    "  --format <format>  pretty (default), json, or raw",
    "",
    "Route input is passed as --field=value pairs after the route name, or as JSON on stdin.",
  ].join("\n");

  try {
    const routes = await client.listRoutes({ dispatchable: "true" });
    return {
      code: EXEC_EXIT.ok,
      output: `${staticHelp}\n\nDispatchable routes on this instance:\n\n${renderRoutes(routes, format)}`,
    };
  } catch (error: unknown) {
    if (!(error instanceof OpsClientError)) throw error;
    return {
      code: failureCode(error),
      output: staticHelp,
      error: `\nEndpoint introspection was refused, so the list above is missing.\n${introspectionBlame(error)}`,
    };
  }
}

function introspectionBlame(error: OpsClientError): string {
  if (error.kind === "absent") {
    return "The introspection tier is not enabled on this instance. Enable it in craft.config.ts with `ops: { tiers: { introspection: true } }`, or a scope string to gate it.";
  }
  return error.message;
}

function failureCode(error: OpsClientError): number {
  if (error.kind === "unreachable") return EXEC_EXIT.unreachable;
  if (error.kind === "refused" || error.kind === "absent") {
    return EXEC_EXIT.refused;
  }
  // A route with no dispatch door is the command naming something that
  // cannot be asked, not a route that ran and failed. Nothing executed, so
  // reporting it as a failure would send a script's error path looking for
  // an exchange that never existed.
  if (error.status === 409) return EXEC_EXIT.usage;
  return EXEC_EXIT.failed;
}

/**
 * Run one dispatch.
 *
 * @param route - Route id to dispatch to, or undefined for `--help`
 * @param args - Trailing arguments that become the request body
 * @param options - Flags plus any piped stdin
 */
export async function execCommand(
  route: string | undefined,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  let settings;
  try {
    settings = resolveSettings(options);
  } catch (error: unknown) {
    if (error instanceof SettingsError) {
      return { code: EXEC_EXIT.usage, error: error.message };
    }
    throw error;
  }

  const client = createOpsClient(settings);
  const format = settings.format.value;

  if (route === undefined) return introspect(client, format);

  const piped = options.stdin?.trim();
  let body: unknown;
  if (piped !== undefined && piped.length > 0) {
    if (args.length > 0) {
      return {
        code: EXEC_EXIT.usage,
        error:
          "Route input arrived both on stdin and as --field=value arguments. Pass one or the other, so which one wins is never a question.",
      };
    }
    try {
      body = JSON.parse(piped);
    } catch (error: unknown) {
      return {
        code: EXEC_EXIT.usage,
        error: `Input on stdin must be JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  } else {
    const parsed = bodyFromArgs(args);
    if (parsed.error !== undefined) {
      return { code: EXEC_EXIT.usage, error: parsed.error };
    }
    body = parsed.body;
  }

  try {
    const outcome = await client.dispatch(route, body);
    const output = renderDispatch(outcome, format);
    // A drop reached a terminal outcome without producing a result, so it
    // is reported as a non-zero exit alongside a failure while staying
    // visibly a different thing in the output.
    return outcome.outcome === "dropped"
      ? { code: EXEC_EXIT.failed, output }
      : { code: EXEC_EXIT.ok, output };
  } catch (error: unknown) {
    if (!(error instanceof OpsClientError)) throw error;
    return {
      code: failureCode(error),
      error: dispatchBlame(error, route, settings),
    };
  }
}

/**
 * Explain a dispatch that never ran.
 *
 * A 404 here is deliberately ambiguous on the wire: a disabled tier and an
 * unknown route answer alike so an unconfigured instance discloses nothing.
 * The client cannot resolve that, so it names every reading rather than
 * picking one and sending the reader down the wrong path.
 */
function dispatchBlame(
  error: OpsClientError,
  route: string,
  settings: ReturnType<typeof resolveSettings>,
): string {
  if (error.kind !== "absent") return error.message;
  const detail = error.detail as
    { code?: string; message?: string } | undefined;
  if (detail?.code !== undefined) return error.message;
  return [
    `The instance at ${settings.url.value} (from the ${describeSource(settings.url)}) did not accept a dispatch to "${route}".`,
    "",
    "One of three things is true, and the instance deliberately does not say which:",
    "  - the dispatch tier is not enabled: set `ops: { tiers: { dispatch: true } }` in craft.config.ts, or a scope string to gate it",
    "  - a credential is needed to see the tier at all: pass --token, set CRAFT_TOKEN, or put one in .routecraft/settings.yaml",
    `  - no route named "${route}" is registered here`,
    "",
    "`craft ops routes` lists what this instance exposes, if introspection is enabled.",
  ].join("\n");
}

/** Serialise an unexpected client failure for the error stream. */
export function unexpected(error: unknown): string {
  return error instanceof Error
    ? error.message
    : asJson(error as Record<string, unknown>);
}
