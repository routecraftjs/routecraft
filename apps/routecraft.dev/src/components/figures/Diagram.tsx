import { ScaledFrame } from '@/components/ScaledFrame'
import { getFigure } from '@/components/figures'
import { FIGURE_PALETTE_THEMED } from '@/components/figures/palette'

/**
 * A figure in the flow of a post. Authored at a fixed canvas and scaled to the
 * column, so the composition never reflows: the same drawing at every width,
 * just smaller. It re-tones with the site theme through
 * {@link FIGURE_PALETTE_THEMED}.
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
  if (!figure) return null

  const { Figure, width, height, alt } = figure
  const text = caption ?? figure.caption

  // A figure sits in the text column, at the measure of the prose around it. It
  // is a block in the argument, not a break from it.
  return (
    <figure className="not-prose my-10">
      {/* On narrow screens these canvases scale down to type nobody can read, so
          the figure keeps a floor width and pans inside its own scroller rather
          than shrinking into mud. A scroll container that holds no focusable
          element is unreachable by keyboard, which would put half of a
          two-column figure out of reach on a phone, so it is a labelled group
          and its own tab stop. */}
      <div
        className="overflow-x-auto"
        tabIndex={0}
        role="group"
        aria-label={text || alt}
      >
        <div className="min-w-[34rem] border border-ink/15">
          <ScaledFrame width={width} height={height} label={alt}>
            <Figure palette={FIGURE_PALETTE_THEMED} />
          </ScaledFrame>
        </div>
      </div>
      {text ? (
        <figcaption className="mt-3 font-mono text-[0.7rem] tracking-[0.18em] text-ink/55 uppercase">
          {text}
        </figcaption>
      ) : null}
    </figure>
  )
}
