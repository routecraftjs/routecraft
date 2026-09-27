import { createFileRoute, notFound } from '@tanstack/react-router'

import { NotFound } from '@/components/NotFound'
import { getFigure } from '@/components/figures'
import { FIGURE_PALETTE_THEMED } from '@/components/figures/palette'
import { FIGURE_EXPORT_ATTRIBUTE } from '@/lib/figure-image'
import { siteName } from '@/lib/site'

/**
 * One figure at its authored size, alone on the page. It is what
 * `scripts/export-figures.ts` screenshots into the committed PNGs that the
 * lightbox, the raw markdown and syndication use, so the element marked with
 * the export attribute wraps the canvas and nothing else.
 *
 * A utility surface rather than an argument, so it is kept out of the index:
 * it would rank as thin content against the post that makes the point.
 */
export const Route = createFileRoute('/figures/$id')({
  loader: ({ params }) => {
    if (!getFigure(params.id)) throw notFound()
  },
  head: ({ params }) => {
    const figure = getFigure(params.id)
    return {
      meta: [
        { title: `${figure?.caption ?? 'Figure'} - ${siteName}` },
        { name: 'description', content: figure?.alt ?? '' },
        { name: 'robots', content: 'noindex, follow' },
      ],
    }
  },
  component: FigurePage,
  notFoundComponent: NotFound,
})

function FigurePage() {
  const { id } = Route.useParams()
  const figure = getFigure(id)
  if (!figure) throw notFound()

  const { Figure, width, height, alt, caption } = figure

  return (
    <main className="container-page py-12">
      <h1 className="font-editorial text-3xl tracking-[-0.02em] text-ink">
        {caption}
      </h1>
      <div className="mt-8 overflow-x-auto">
        <div
          {...{ [FIGURE_EXPORT_ATTRIBUTE]: '' }}
          role="img"
          aria-label={alt}
          style={{ width, height }}
        >
          <Figure palette={FIGURE_PALETTE_THEMED} />
        </div>
      </div>
    </main>
  )
}
