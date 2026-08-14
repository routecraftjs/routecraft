/**
 * Colour contract for the full figures, which render in the browser only. Every
 * value is passed in rather than read from CSS, so a figure carries no implicit
 * dependency on the classes around it and re-tones with the site's light/dark
 * flip through the one themed palette below.
 *
 * Motifs are the other half of the system and do NOT use this contract: they
 * render through Satori as well as the browser, and take the cover's
 * `CoverPalette` instead. `COVER_PALETTE_LIGHT` is where the Satori-literal
 * values live.
 *
 * Alpha steps are spelled out as named keys rather than computed at the call
 * site, so a figure never has to know which colour syntax its surface supports.
 */
export interface FigurePalette {
  /** Frame background. */
  paper: string
  /** Card and panel fill, one step off the paper. */
  paperDeep: string
  /** Primary type and marks. */
  ink: string
  /** Ink at 60%: secondary labels inside panels. */
  ink60: string
  /** Ink at 55%: eyebrows, footnotes, muted mono. */
  ink55: string
  /** Ink at 40%: arrows, dashed plates. */
  ink40: string
  /** Ink at 35%: panel borders that must still read as structure. */
  ink35: string
  /** Ink at 25%: chip borders. */
  ink25: string
  /** Ink at 15%: hairlines and dividers. */
  ink15: string
  /** The one accent. */
  accent: string
  /** Accent at 40%: internal rules inside an accented panel. */
  accent40: string
  /** Accent at 6%: the wash behind a highlighted row. */
  accent06: string
  /** Inverted plate background (the ink-on-paper reversal). */
  inverseBg: string
  /** Type on an inverted plate. */
  inverseFg: string
}

/**
 * Browser palette for a figure in the flow of a post. Follows the site tokens,
 * so the light/dark flip in tailwind.css re-tones the figure with the page.
 */
export const FIGURE_PALETTE_THEMED: FigurePalette = {
  paper: 'var(--color-paper)',
  paperDeep: 'color-mix(in srgb, var(--color-paper-deep) 40%, transparent)',
  ink: 'var(--color-ink)',
  ink60: 'color-mix(in srgb, var(--color-ink) 60%, transparent)',
  ink55: 'color-mix(in srgb, var(--color-ink) 55%, transparent)',
  ink40: 'color-mix(in srgb, var(--color-ink) 40%, transparent)',
  ink35: 'color-mix(in srgb, var(--color-ink) 35%, transparent)',
  ink25: 'color-mix(in srgb, var(--color-ink) 25%, transparent)',
  ink15: 'color-mix(in srgb, var(--color-ink) 15%, transparent)',
  accent: 'var(--color-cobalt-500)',
  accent40: 'color-mix(in srgb, var(--color-cobalt-500) 40%, transparent)',
  accent06: 'color-mix(in srgb, var(--color-cobalt-500) 6%, transparent)',
  inverseBg: 'var(--color-ink)',
  inverseFg: 'var(--color-paper)',
}
