/**
 * Routecraft brand theme for the TUI.
 *
 * Mirrors the site's three-family palette (paper / ink / cobalt) and its
 * core rule: cobalt is the only accent and appears only on focus, selection
 * and active states; status colors are semantic; everything else is
 * neutral. The hex values are the dark-mode re-tone of the cobalt scale
 * from the brand book (tuned for dark grounds, which terminals are).
 * Terminals without truecolor support downgrade them to the nearest ANSI
 * color automatically.
 */
export const theme = {
  /** Cobalt 500 (dark re-tone). Focus borders, selection, active nav. */
  accent: "#7482ff",
  /** Cobalt 600 (dark re-tone). Secondary accent: values, key hints. */
  accentSoft: "#9ea8fd",
  /** Healthy / completed. */
  success: "green",
  /** Failures. */
  error: "red",
  /** Warnings, pending, registered-but-idle. */
  warn: "yellow",
  /** Hairlines, inactive panel borders, secondary text. */
  muted: "gray",
} as const;

/**
 * Spread props for a selected list row or nav item: accent + bold,
 * nothing at rest (the brand keeps cobalt off resting elements).
 */
export function selectedProps(selected: boolean): {
  color?: string;
  bold?: boolean;
} {
  return selected ? { color: theme.accent, bold: true } : {};
}
