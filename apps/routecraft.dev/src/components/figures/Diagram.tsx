import { Lightbox } from '@/components/Lightbox'
import { ScaledFrame } from '@/components/ScaledFrame'
import { getFigure } from '@/components/figures'
import { FIGURE_PALETTE_THEMED } from '@/components/figures/palette'
import { figureImagePath } from '@/lib/figure-image'

/**
 * A figure in the flow of a post. Authored at a fixed canvas and scaled to the
 * column, so the composition never reflows: the same drawing at every width,
 * just smaller. It re-tones with the site theme through
 * {@link FIGURE_PALETTE_THEMED}.
 *
 * Scaled into a phone column the drawing is complete but too small to read, so
 * it opens full-screen on tap, showing the exported PNG at full resolution for
 * the reader to pinch-zoom. The overlay carries a light and a dark file rather
 * than one neutral image, so an enlarged figure matches the theme it was opened
 * from. Only the overlay's images are fetched, and only once it is opened.
 *
 * Used by the `{% diagram %}` Markdoc tag.
 */
export function Diagram({
  id,
  caption,
}: {
  id?: string
  /** Overrides the figure's own caption. Pass `""` to render none. */
  caption?: string
}) {
  const figure = getFigure(id)
  if (!figure || !id) return null

  const { Figure, width, height, alt } = figure
  const text = caption ?? figure.caption

  // A figure sits in the text column, at the measure of the prose around it. It
  // is a block in the argument, not a break from it.
  return (
    <figure className="not-prose my-10">
      <Lightbox
        label={`Expand figure: ${alt}`}
        alt={alt}
        caption={text || alt}
        image={figureImagePath(id)}
        imageDark={figureImagePath(id, 'dark')}
      >
        <div className="border border-ink/15 transition duration-500 group-hover/lightbox:border-cobalt-500/40">
          <ScaledFrame width={width} height={height} label={alt}>
            <Figure palette={FIGURE_PALETTE_THEMED} />
          </ScaledFrame>
        </div>
      </Lightbox>
      <figcaption className="mt-3 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[0.7rem] tracking-[0.18em] text-ink/55 uppercase">
        {text ? <span>{text}</span> : null}
        {/* At column width on a phone the drawing reads as a picture, not as
            labels, so the way in has to be stated rather than discovered. */}
        <span aria-hidden="true" className="text-ink/40 sm:hidden">
          Tap to enlarge
        </span>
      </figcaption>
    </figure>
  )
}
