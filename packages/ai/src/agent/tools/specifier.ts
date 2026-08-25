import { rcError } from "@routecraft/routecraft";
import type { FnOptions, ToolGuard } from "../../fn/types.ts";
import { isDeferredFn, type FnEntry } from "./types.ts";

/**
 * Use-site specifier dispatch for the tool-reference grammar.
 *
 * `Tool(specifier)` attaches a constraint to one tool at the point it is
 * granted. This module owns the grammar half of that: recognising the
 * form, unioning the specifiers written for the same tool, and handing
 * them to the tool that declared how to read them. It never interprets a
 * specifier itself.
 *
 * That split is what keeps the dispatch general. A command surface
 * (`Bash(git status:*)`) and a host surface both parse identically here
 * and diverge only inside the matcher each tool supplies, so a second
 * consumer needs no changes to this file.
 */

/**
 * Grammar keywords that already use the `Name(...)` shape for something
 * other than a specifier. They resolve a tool's identity rather than
 * constrain one, so they are never routed here.
 */
const RESERVED = new Set(["Direct", "MCP", "Agent"]);

/** A parsed `Tool(specifier)` reference. */
export interface SpecifierRef {
  /** The tool being constrained. */
  readonly name: string;
  /** The text inside the parentheses. */
  readonly body: string;
}

/**
 * Recognise a use-site specifier reference.
 *
 * Returns `undefined` for anything else, including the reserved
 * constructors and a bare tool name, so callers can fall through to the
 * existing resolution paths unchanged.
 *
 * @internal
 */
export function parseSpecifierRef(ref: string): SpecifierRef | undefined {
  const split = splitToolRef(ref);
  if (!split) return undefined;
  const { name, body } = split;
  if (RESERVED.has(name)) return undefined;
  if (body === "") {
    throw rcError("RC5003", undefined, {
      message:
        `tools(): "${ref}" has an empty specifier. Write the constraint inside the parentheses ` +
        `(for a command surface, "${name}(git status:*)"), or grant the tool unconstrained as "${name}".`,
    });
  }
  return { name, body };
}

/**
 * Split a `Name(body)` reference into its parts. Grammar only: it applies
 * no policy, throws for nothing, and knows nothing about which names are
 * reserved.
 *
 * The one place the shape of a tool reference is decided. Two readings of
 * it that must agree and do not is how a deny stops denying, or how a
 * reference the loader waves through is read differently downstream.
 *
 * @internal
 */
export function splitToolRef(
  ref: string,
): { name: string; body: string } | undefined {
  const match = /^([A-Za-z_][A-Za-z0-9_-]*)\((.*)\)$/s.exec(ref.trim());
  return match ? { name: match[1]!, body: match[2]!.trim() } : undefined;
}

/**
 * The tool a reference names, with any use-site specifier stripped.
 *
 * `Bash(git status:*)` and `Bash` are the same tool granted with and
 * without a constraint, so identity questions (is it registered, is it a
 * built-in, was it denied) are asked of the name.
 *
 * A reserved constructor is returned whole: `Direct(orders.cancel)` names
 * one route rather than a tool called `Direct`, so collapsing it would let
 * a deny for one route remove every other.
 *
 * @internal
 */
export function toolNameOf(ref: string): string {
  const split = splitToolRef(ref);
  if (!split || RESERVED.has(split.name)) return ref.trim();
  return split.name;
}

/**
 * Collect every specifier written for each tool across a selection.
 *
 * Repeated entries union rather than replace, which is what makes
 * `Bash(git status:*)` and `Bash(ls)` on separate lines mean both. Union
 * is also the only safe direction to resolve a repeat in: the alternative
 * silently drops a grant the author wrote.
 *
 * @internal
 */
export function collectSpecifiers(
  refs: readonly string[],
): Map<string, string[]> {
  const collected = new Map<string, string[]>();
  for (const ref of refs) {
    const parsed = parseSpecifierRef(ref);
    if (!parsed) continue;
    const existing = collected.get(parsed.name);
    if (existing) existing.push(parsed.body);
    else collected.set(parsed.name, [parsed.body]);
  }
  return collected;
}

/**
 * Compile a tool's unioned specifiers into the guard that enforces them.
 *
 * @param entry - The registered fn the specifier constrains
 * @param name - Tool name, for diagnostics
 * @param bodies - Every specifier written for this tool
 * @throws RC5003 when the tool declares no specifier support
 *
 * @internal
 */
export function compileSpecifier(
  entry: FnEntry,
  name: string,
  bodies: readonly string[],
): ToolGuard {
  const declaration = isDeferredFn(entry)
    ? undefined
    : (entry as FnOptions).specifier;
  if (!declaration) {
    throw rcError("RC5003", undefined, {
      message:
        `tools(): "${name}(${bodies[0] ?? ""})" attaches a specifier to a tool that does not accept one. ` +
        `A specifier narrows what a tool may do, so ignoring it would grant more than was written. ` +
        `Grant the tool as "${name}", or register it with a specifier declaration if it should be narrowable.`,
    });
  }
  return declaration.compile(bodies);
}

/**
 * Run two guards as one. Both must pass, because each was written to
 * withhold something and a combination that let either one through would
 * grant more than either author intended.
 *
 * @internal
 */
export function combineGuards(
  first: ToolGuard | undefined,
  second: ToolGuard,
): ToolGuard {
  if (!first) return second;
  return async (input, ctx) => {
    await first(input, ctx);
    await second(input, ctx);
  };
}
