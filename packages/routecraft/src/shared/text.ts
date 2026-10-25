/**
 * Cut `text` to at most `max` characters (code points), ellipsis included,
 * so a cut never splits a surrogate pair; in UTF-16 units the result is at
 * most twice `max`. The cap is in characters on purpose: it is what a reader
 * counts, and a text of `max` astral characters is still bounded. Only the
 * head is walked: a code point spans at most two UTF-16 units, so twice the
 * cap in units holds every code point that can survive.
 *
 * A cap too small to hold the ellipsis (under 3) keeps the head alone, so
 * the result never exceeds `max`.
 *
 * @param text - The text to bound
 * @param max - The most characters the result may hold
 * @returns `text` itself when it fits, else its head and an ellipsis
 * @internal
 */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const chars = Array.from(text.slice(0, max * 2));
  if (text.length <= max * 2 && chars.length <= max) return text;
  return max < 3
    ? chars.slice(0, Math.max(0, max)).join("")
    : `${chars.slice(0, max - 3).join("")}...`;
}
