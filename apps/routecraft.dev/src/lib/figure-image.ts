/**
 * The typed face of the figure image contract, shared by the figure pages, the
 * `{% diagram %}` tag and `scripts/export-figures.ts`.
 *
 * A figure is HTML and CSS, so it only draws in a real browser: a standalone
 * `.svg` renders blank through an `<img>` tag, and Satori cannot lay it out
 * either. The only portable form is a raster, so the export script screenshots
 * each figure page with a headless browser and writes a PNG to `public/`.
 *
 * The paths themselves come from `figures/manifest.mjs`, which is plain
 * JavaScript so the prebuild scripts and the markdoc cleaner can read the same
 * definitions without a TypeScript loader.
 */
import {
  FIGURE_DARK_SUFFIX,
  FIGURE_IMAGE_DIR,
  figureImagePath as figureImagePathJs,
} from '@/components/figures/manifest.mjs'

export { FIGURE_DARK_SUFFIX, FIGURE_IMAGE_DIR }

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

/** Site-relative path to a figure's exported PNG. */
export function figureImagePath(
  id: string,
  theme: FigureTheme = 'light',
): string {
  return figureImagePathJs(id, theme)
}
