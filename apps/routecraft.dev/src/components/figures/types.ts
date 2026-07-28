import type { ReactElement } from 'react'

import type { CoverPalette } from '@/components/BlogCover'
import type { FigurePalette } from '@/components/figures/palette'

export interface FigureProps {
  palette: FigurePalette
}

export interface MotifProps {
  /**
   * The motif sits inside the cover, so it takes the cover's palette and
   * inherits its hover-invert and theme flip for free.
   */
  palette: CoverPalette
  /** Edge of the square the motif is drawn into. */
  size: number
}

/**
 * One diagram, in two resolutions.
 *
 * `Figure` is the full drawing: authored at a fixed canvas, scaled to fit by
 * {@link ScaledFrame}, and legible only at post-body width or larger. It renders
 * in the browser alone, so it may use grid and `color-mix`. Colour and type come
 * from the `primitives` vocabulary and the `palette` prop, never from Tailwind
 * classes, so the drawing stays self-contained.
 *
 * `Motif` is the same idea reduced to shapes that survive a 368px card and a
 * social preview. It replaces the cover's glyph, which means it renders through
 * Satori as well: inline styles only, flexbox only, no CSS variables, no
 * pseudo-elements, no `color-mix`. It takes no font, because a motif that needs
 * words has not been reduced far enough.
 */
export interface FigureDrawing {
  /** Stable id used in frontmatter and in the `{% diagram %}` tag. */
  id: string
  width: number
  height: number
  Figure: (props: FigureProps) => ReactElement
  Motif: (props: MotifProps) => ReactElement
}

/**
 * A figure's words. They live in `manifest.mjs` rather than beside the drawing,
 * because the raw markdown build and the markdoc cleaner have to read them
 * without loading JSX: `{% diagram %}` becomes a real markdown image in
 * `public/raw/**`, and its alt text is all a reader who cannot fetch the PNG
 * has to go on.
 */
export interface FigureText {
  /** Sentence describing what the figure shows. Becomes the accessible name. */
  alt: string
  /** Default caption when the tag does not override it. */
  caption: string
}

/** A drawing joined to its words, which is what every consumer renders. */
export type FigureDefinition = FigureDrawing & FigureText
