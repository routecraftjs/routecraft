/**
 * The command-line input grammar, shared by `craft exec` and the `argv()`
 * source so the same arguments make the same body on both doors.
 */

/**
 * Turn `--flag=value` arguments into a request body.
 *
 * Flat and predictable on purpose: a bare flag is `true`, a repeated flag
 * becomes an array, and everything else is the string the shell passed.
 * Nothing is coerced to a number, because a route that wants one declares
 * it with `.input()` and a CLI guessing types is a source of bugs that only
 * appear for values that look numeric.
 *
 * Anything richer than that goes in on stdin as JSON.
 *
 * @internal
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
 * The request body from a command line: JSON on stdin, or `--field=value`
 * arguments, never both.
 *
 * Both at once is refused rather than merged, so which one wins is never a
 * question. Blank stdin counts as none, because a shell hands a command an
 * empty pipe far more often than it means "an empty body".
 *
 * Exported for runners: `craft exec` parses with it, and a runner of its own
 * that hands an `argv()` route its input parses the same way.
 *
 * @param args - The arguments after the route name or file
 * @param stdin - What arrived on a piped stdin, if anything
 * @returns The body, or the usage error to print
 *
 * @example
 * ```typescript
 * commandLineInput(["--id=1", "--tag=a", "--tag=b"], undefined);
 * // { body: { id: "1", tag: ["a", "b"] } }
 * ```
 */
export function commandLineInput(
  args: readonly string[],
  stdin: string | undefined,
): { body: unknown } | { error: string } {
  const piped = stdin?.trim();
  if (piped === undefined || piped.length === 0) {
    const parsed = bodyFromArgs(args);
    return parsed.error === undefined
      ? { body: parsed.body }
      : { error: parsed.error };
  }
  if (args.length > 0) {
    return {
      error:
        "Route input arrived both on stdin and as --field=value arguments. Pass one or the other, so which one wins is never a question.",
    };
  }
  try {
    return { body: JSON.parse(piped) as unknown };
  } catch (error: unknown) {
    return {
      error: `Input on stdin must be JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
