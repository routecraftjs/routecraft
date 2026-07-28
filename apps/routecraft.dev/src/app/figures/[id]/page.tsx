import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { allFigures, getFigure } from '@/components/figures'
import { FIGURE_PALETTE_THEMED } from '@/components/figures/palette'
import {
  FIGURE_EXPORT_ATTRIBUTE,
  FIGURE_EXPORT_SCALE,
  FIGURE_THEMES,
  figureImagePath,
} from '@/lib/figure-image'
import { absoluteUrl } from '@/lib/site'

export const dynamic = 'force-static'

export function generateStaticParams() {
  return allFigures().map((figure) => ({ id: figure.id }))
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const figure = getFigure((await params).id)
  if (!figure) return {}

  return {
    title: figure.caption,
    description: figure.alt,
    // A figure page is a utility surface for reuse, not an argument. It would
    // rank as thin content against the post that actually makes the point.
    robots: { index: false, follow: true },
  }
}

export default async function FigurePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const figure = getFigure(id)
  if (!figure) notFound()

  const { Figure, width, height, alt, caption } = figure
  const snippet = `![${alt}](${absoluteUrl(figureImagePath(id))})`

  return (
    <div className="mx-auto w-full max-w-8xl px-4 py-12 sm:px-6 lg:px-8">
      <Link
        href="/figures"
        className="font-mono text-[0.7rem] tracking-[0.18em] text-ink/55 uppercase transition hover:text-cobalt-500"
      >
        &larr; All figures
      </Link>

      <h1 className="mt-6 font-editorial text-3xl tracking-[-0.02em] text-ink sm:text-4xl">
        {caption}
      </h1>
      <p className="mt-4 max-w-3xl text-ink/70">{alt}</p>

      {/* The figure is drawn at its authored size, not scaled to the column:
          this page is where you come to grab it, so what you see is what the
          PNG contains. Wider than a laptop viewport for most figures, hence the
          scroller. The export lifts the marked element out of the page before
          screenshotting, so no ancestor here can crop it. */}
      {/* max-w-fit keeps the frame hugging a canvas narrower than the page and
          lets it scroll when it is wider. A scroll container holding nothing
          focusable is unreachable by keyboard, so it is its own tab stop. */}
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
          {height * FIGURE_EXPORT_SCALE}, once per theme. Hotlink either from
          dev.to or any other syndication target, or save one for a slide. The
          snippet below uses light, which is the safer default on a surface
          whose background you do not control.
        </p>
        <dl className="mt-6 space-y-3">
          {FIGURE_THEMES.map((theme) => (
            <div key={theme} className="sm:flex sm:gap-4">
              <dt className="font-mono text-[0.7rem] tracking-[0.18em] text-ink/55 uppercase sm:w-16 sm:shrink-0 sm:pt-1">
                {theme}
              </dt>
              <dd>
                <a
                  href={figureImagePath(id, theme)}
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
    </div>
  )
}
