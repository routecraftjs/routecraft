import { createFileRoute, notFound } from '@tanstack/react-router'

import { AppLink } from '@/components/AppLink'
import { NotFound } from '@/components/NotFound'
import { getFigure } from '@/components/figures'
import { FIGURE_PALETTE_THEMED } from '@/components/figures/palette'
import {
  FIGURE_EXPORT_ATTRIBUTE,
  FIGURE_EXPORT_SCALE,
  FIGURE_THEMES,
  figureImagePath,
} from '@/lib/figure-image'
import { absoluteUrl, siteName } from '@/lib/site'

/**
 * One figure at its authored size, next to the URLs and markdown snippet for
 * its PNGs. It is also what `scripts/export-figures.ts` screenshots, so the
 * element marked with the export attribute wraps the canvas and nothing else.
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
  const snippet = `![${alt}](${absoluteUrl(figureImagePath(id))})`

  return (
    <main className="container-page py-12">
      <AppLink
        href="/figures/"
        className="font-mono text-[0.7rem] tracking-[0.18em] text-ink/55 uppercase transition hover:text-cobalt-500"
      >
        &larr; All figures
      </AppLink>

      <h1 className="mt-6 font-editorial text-3xl tracking-[-0.02em] text-ink sm:text-4xl">
        {caption}
      </h1>
      <p className="mt-4 max-w-3xl text-ink/70">{alt}</p>

      {/* Authored size, not scaled to the column: what you see is what the PNG
          contains. A scroller with nothing focusable is its own tab stop. */}
      <div
        className="mt-10 max-w-fit overflow-x-auto border border-ink/15"
        tabIndex={0}
        role="group"
        aria-label={alt}
      >
        <div {...{ [FIGURE_EXPORT_ATTRIBUTE]: '' }} style={{ width, height }}>
          <Figure palette={FIGURE_PALETTE_THEMED} />
        </div>
      </div>

      <div className="mt-10 max-w-3xl">
        <h2 className="font-mono text-[0.7rem] tracking-[0.18em] text-ink/55 uppercase">
          Reuse this figure
        </h2>
        <p className="mt-4 text-ink/70">
          Exported from this page at {width * FIGURE_EXPORT_SCALE}&times;
          {height * FIGURE_EXPORT_SCALE}, once per theme. Hotlink either from a
          syndication target, or save one for a slide. The snippet uses light,
          the safer default on a surface whose background you do not control.
        </p>
        <dl className="mt-6 space-y-3">
          {FIGURE_THEMES.map((theme) => (
            <div key={theme} className="sm:flex sm:gap-4">
              <dt className="font-mono text-[0.7rem] tracking-[0.18em] text-ink/55 uppercase sm:w-16 sm:shrink-0 sm:pt-1">
                {theme}
              </dt>
              <dd>
                <a
                  href={absoluteUrl(figureImagePath(id, theme))}
                  className="font-mono text-sm break-all text-cobalt-500 hover:underline"
                >
                  {absoluteUrl(figureImagePath(id, theme))}
                </a>
              </dd>
            </div>
          ))}
        </dl>
        <pre className="mt-6 overflow-x-auto border border-ink/15 bg-paper-deep/40 p-4 font-mono text-xs text-ink/80">
          {snippet}
        </pre>
      </div>
    </main>
  )
}
