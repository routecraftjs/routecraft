import { createFileRoute } from '@tanstack/react-router'

import { AppLink } from '@/components/AppLink'
import { ScaledFrame } from '@/components/ScaledFrame'
import { allFigures } from '@/components/figures'
import { FIGURE_PALETTE_THEMED } from '@/components/figures/palette'
import { siteName } from '@/lib/site'

/**
 * Every figure, one card each, linking to the page that hands over its PNGs.
 * Kept out of the index for the same reason as the figure pages.
 */
export const Route = createFileRoute('/figures/')({
  head: () => ({
    meta: [
      { title: `Figures - ${siteName}` },
      {
        name: 'description',
        content:
          'Every Routecraft figure, with a PNG for each so a post can be syndicated with its artwork intact.',
      },
      { name: 'robots', content: 'noindex, follow' },
    ],
  }),
  component: FiguresPage,
})

function FiguresPage() {
  return (
    <main className="container-page py-12">
      <p className="font-mono text-[0.7rem] tracking-[0.18em] text-ink/55 uppercase">
        Figures
      </p>
      <h1 className="mt-4 font-editorial text-3xl tracking-[-0.02em] text-ink sm:text-4xl">
        Every figure
      </h1>
      <p className="mt-4 max-w-3xl text-ink/70">
        One page each. The figures are drawn in the browser, so each page also
        carries an exported PNG you can hotlink where a post is syndicated
        somewhere that cannot render them.
      </p>

      <ul className="mt-12 grid grid-cols-1 gap-10 lg:grid-cols-2">
        {allFigures().map((figure) => (
          <li key={figure.id}>
            <AppLink href={`/figures/${figure.id}/`} className="group block">
              <div className="border border-ink/15 transition group-hover:border-cobalt-500/50">
                <ScaledFrame
                  width={figure.width}
                  height={figure.height}
                  label={figure.alt}
                >
                  <figure.Figure palette={FIGURE_PALETTE_THEMED} />
                </ScaledFrame>
              </div>
              <p className="mt-4 font-mono text-[0.7rem] tracking-[0.18em] text-ink/55 uppercase">
                {figure.id}
              </p>
              <p className="mt-2 text-ink transition group-hover:text-cobalt-500">
                {figure.caption}
              </p>
            </AppLink>
          </li>
        ))}
      </ul>
    </main>
  )
}
