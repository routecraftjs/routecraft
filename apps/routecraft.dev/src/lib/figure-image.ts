/**
 * The contract between the figure pages and `scripts/export-figures.ts`.
 *
 * A figure is HTML and CSS inside a `<foreignObject>`, so it only draws in a
 * real browser: a standalone `.svg` renders blank through an `<img>` tag, and
 * Satori cannot lay it out either. The only portable form is a raster, so the
 * export script screenshots each figure page with a headless browser and writes
 * a PNG to `public/`. Both sides read the path and the marker attribute from
 * here so the page and the script cannot drift apart.
 */

/** Where exported PNGs live, under `public/` and under the site root alike. */
export const FIGURE_IMAGE_DIR = 'images/figures'

/**
 * Marks the element the export screenshots. The script lifts this element out
 * of the page before capturing, so it must wrap the figure canvas and nothing
 * else: no padding, no border, no caption.
 */
export const FIGURE_EXPORT_ATTRIBUTE = 'data-figure-export'

/** Pixel ratio the PNGs are rendered at, so type survives a retina screen. */
export const FIGURE_EXPORT_SCALE = 2

/**
 * A figure re-tones with the site theme, so it exports twice. Light is the
 * unsuffixed file: it is what a syndication target with no dark surface should
 * get, and it is the one URL worth being guessable.
 */
export type FigureTheme = 'light' | 'dark'

export const FIGURE_THEMES: readonly FigureTheme[] = ['light', 'dark']

/** Suffix appended to a figure id for a non-default theme. */
export const FIGURE_DARK_SUFFIX = '-dark'

/** Site-relative path to a figure's exported PNG. */
export function figureImagePath(
  id: string,
  theme: FigureTheme = 'light',
): string {
  const suffix = theme === 'dark' ? FIGURE_DARK_SUFFIX : ''
  return `/${FIGURE_IMAGE_DIR}/${id}${suffix}.png`
}
