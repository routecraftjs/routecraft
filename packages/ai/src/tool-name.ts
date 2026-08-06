/**
 * The single definition of what a tool name may look like once it
 * reaches a model provider.
 *
 * Every LLM-facing name this package generates is constrained by the
 * same rule: the fn id, the `direct__<routeId>` form for capabilities,
 * the `mcp__<server>__<tool>` form for client tools, the
 * `_block__load__<name>` form for synthetic block loaders, and the route
 * ids the `mcp()` source exposes as tools. The constraint comes from
 * OpenAI's function-calling charset, the strictest of the mainstream
 * clients, which the other providers and MCP implementations respect.
 *
 * These constants previously existed in three independent copies (the
 * MCP types module, the MCP source adapter, the block resolver). They
 * live here so a change to the provider contract is one edit rather
 * than three, and so no generation path can drift out of agreement with
 * the paths that validate.
 */

/**
 * Characters permitted in a provider-facing tool name: ASCII letters,
 * digits, underscore, and hyphen. Unanchored to a length so callers
 * that build a name in parts can check the charset of a segment
 * separately from the length of the whole.
 */
export const TOOL_NAME_CHARSET = /^[A-Za-z0-9_-]+$/;

/** Maximum provider-facing tool-name length. */
export const TOOL_NAME_MAX_LENGTH = 64;

/**
 * The full constraint: charset plus length, anchored. Equivalent to
 * `TOOL_NAME_CHARSET` bounded by `TOOL_NAME_MAX_LENGTH`, kept as one
 * expression for the many call sites that validate a complete name.
 */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The sole structural separator in a synthetic tool name.
 *
 * Every name this package composes from parts joins them with `__`:
 * `direct__<routeId>`, `mcp__<server>__<tool>`,
 * `_block__load__<name>`. A single underscore is therefore never a
 * boundary, which is what makes a name with an underscore inside a
 * segment (a server called `my_company_api`, a route called
 * `fetch_order`) unambiguous against the prefix that precedes it.
 *
 * Prefixes must not contain `__` internally, or the boundary they are
 * supposed to mark stops being findable.
 */
export const TOOL_NAME_SEPARATOR = "__";

/**
 * True when `name` is usable as a provider-facing tool name, both in
 * charset and in length.
 */
export function isValidToolName(name: string): boolean {
  return TOOL_NAME_PATTERN.test(name);
}

/**
 * Explain why `name` is not a usable tool name, or return `undefined`
 * when it is fine. Callers embed the reason in their own error so the
 * message names the thing the developer actually wrote (a route id, a
 * block name) rather than the derived tool name alone.
 *
 * Length is reported before charset when both are wrong, because a name
 * that is too long is usually a structural problem (a deeply nested
 * block group) while a bad character is usually a typo.
 */
export function describeToolNameViolation(name: string): string | undefined {
  if (name.length === 0) return "it is empty";
  if (name.length > TOOL_NAME_MAX_LENGTH) {
    return `it is ${name.length} characters, over the provider limit of ${TOOL_NAME_MAX_LENGTH}`;
  }
  if (!TOOL_NAME_CHARSET.test(name)) {
    const offending = [
      ...new Set(name.split("").filter((c) => !/[A-Za-z0-9_-]/.test(c))),
    ];
    return `it contains ${offending.map((c) => `"${c}"`).join(", ")}, outside the allowed set of letters, digits, "_", and "-"`;
  }
  return undefined;
}
