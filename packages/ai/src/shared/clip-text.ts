/**
 * Cut `text` to at most `max` UTF-16 units, the ellipsis included, by code
 * point, so a cut never splits a surrogate pair. Only the head is walked: a
 * code point spans at most two units, so twice the cap in units holds every
 * code point that can survive.
 *
 * Core's `caller-refusal.ts` keeps the same rule for schema issues; the
 * package boundary keeps it out of core's public entry point, so this is
 * the `@routecraft/ai` copy.
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
