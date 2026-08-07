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
 * The one place the permitted characters are written down. Everything
 * else in this module composes from it, so raising the limit or
 * widening the set is a single edit rather than several that a reviewer
 * has to notice are related.
 *
 * @internal
 */
const TOOL_NAME_CHARACTER_CLASS = "[A-Za-z0-9_-]";

/**
 * Matches a single permitted character. Used to name the offending
 * characters in {@link describeToolNameViolation}. Stateless (no `g`
 * flag), so repeated `.test` calls do not carry `lastIndex` between
 * them.
 *
 * @internal
 */
const TOOL_NAME_CHARACTER = new RegExp(TOOL_NAME_CHARACTER_CLASS);

/**
 * Characters permitted in a provider-facing tool name: ASCII letters,
 * digits, underscore, and hyphen. Unanchored to a length so callers
 * that build a name in parts can check the charset of a segment
 * separately from the length of the whole.
 *
 * @internal
 */
export const TOOL_NAME_CHARSET = new RegExp(`^${TOOL_NAME_CHARACTER_CLASS}+$`);

/**
 * Maximum provider-facing tool-name length.
 *
 * @internal
 */
export const TOOL_NAME_MAX_LENGTH = 64;

/**
 * The full constraint: charset plus length, anchored. Built from
 * {@link TOOL_NAME_CHARSET}'s character class and
 * {@link TOOL_NAME_MAX_LENGTH} rather than restating either, so the
 * three cannot disagree.
 *
 * @internal
 */
export const TOOL_NAME_PATTERN = new RegExp(
  `^${TOOL_NAME_CHARACTER_CLASS}{1,${TOOL_NAME_MAX_LENGTH}}$`,
);

/**
 * The constraint rendered for error messages and suggestions, in the
 * anchored `/.../` form a developer would recognise as a regex.
 *
 * Derived so an error can never instruct someone to satisfy a rule the
 * validator has stopped enforcing.
 *
 * @internal
 */
export const TOOL_NAME_PATTERN_SOURCE = `/${TOOL_NAME_PATTERN.source}/`;

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
 *
 * @internal
 */
export const TOOL_NAME_SEPARATOR = "__";

/**
 * True when `segment` can be the leading part of a composed name that
 * a reader splits at the FIRST separator, `mcp__<server>__<tool>` being
 * the one such name today.
 *
 * Three shapes break that split, and the two that are not obvious are
 * the reason this is a function rather than an inline `includes`:
 *
 * - an internal `__` moves the boundary left (`a__b` + `c` composes
 *   `mcp__a__b__c`, read back as server `a`, tool `b__c`)
 * - a TRAILING single `_` does the same, because the segment's own
 *   underscore joins the separator (`foo_` + `bar` composes
 *   `mcp__foo___bar`, read back as server `foo`, tool `_bar`). Worse,
 *   that is the name `foo` + `_bar` composes, so two distinct pairs
 *   collapse onto one and whichever resolves last wins
 * - an empty segment leaves nothing between the separators
 *
 * Testing the segment with one separator-half appended catches the
 * first two in a single condition.
 *
 * Deliberately NOT a general "is this a valid name segment" predicate.
 * `_block__load__<name>` is composed from the same separator but is
 * never split this way (the prefix is fixed and everything after it is
 * the block name), so block names may and do contain `__`. Only names
 * whose reader searches for the first separator are in scope.
 *
 * Callers choose their own reaction: `mcpPlugin({ clients })` throws
 * RC5003, because the name is chosen locally and can be fixed; agent
 * resolution drops the tool with a warning, because the registry can be
 * populated without going through the plugin.
 *
 * @internal
 */
export function isSplittableNameHead(segment: string): boolean {
  if (segment === "") return false;
  const separatorHalf = TOOL_NAME_SEPARATOR.slice(
    0,
    TOOL_NAME_SEPARATOR.length / 2,
  );
  return !`${segment}${separatorHalf}`.includes(TOOL_NAME_SEPARATOR);
}

/**
 * True when `name` is usable as a provider-facing tool name, both in
 * charset and in length.
 *
 * @internal
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
 *
 * @internal
 */
export function describeToolNameViolation(name: string): string | undefined {
  if (name.length === 0) return "it is empty";
  if (name.length > TOOL_NAME_MAX_LENGTH) {
    return `it is ${name.length} characters, over the provider limit of ${TOOL_NAME_MAX_LENGTH}`;
  }
  if (!TOOL_NAME_CHARSET.test(name)) {
    // Iterate code points, not UTF-16 units: `split("")` would tear a
    // non-BMP character into two lone surrogates and report them as two
    // separate mystery characters rather than the one the author typed.
    const offending = [
      ...new Set([...name].filter((c) => !TOOL_NAME_CHARACTER.test(c))),
    ];
    return `it contains ${offending.map((c) => `"${c}"`).join(", ")}, outside the allowed set of letters, digits, "_", and "-"`;
  }
  return undefined;
}
