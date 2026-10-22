/**
 * Cut `text` to at most `max` characters (code points), the ellipsis
 * included, so a cut never splits a surrogate pair. The cap is in
 * characters on purpose: it is what a reader counts, and a text of `max`
 * astral characters is still bounded, at twice `max` UTF-16 units. Only the
 * head is walked, since a code point spans at most two units.
 *
 * Core's `caller-refusal.ts` keeps the same rule for schema issues, with
 * tests pinning it; the package boundary keeps it out of core's public
 * entry point, so this is the `@routecraft/ai` copy.
 *
 * @internal
 */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const chars = Array.from(text.slice(0, max * 2));
  return text.length <= max * 2 && chars.length <= max
    ? text
    : `${chars.slice(0, max - 3).join("")}...`;
}
