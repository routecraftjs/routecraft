import type { Metadata } from 'next'
import Link from 'next/link'

import { ScaledFrame } from '@/components/ScaledFrame'
import { allFigures } from '@/components/figures'
import { FIGURE_PALETTE_THEMED } from '@/components/figures/palette'

export const dynamic = 'force-static'

export const metadata: Metadata = {
  title: 'Figures',
  description:
    'Every diagram from the Routecraft blog, with a PNG for each so a post can be syndicated with its artwork intact.',
  robots: { index: false, follow: true },
}

export default function FiguresPage() {
  return (
    <div className="mx-auto w-full max-w-8xl px-4 py-12 sm:px-6 lg:px-8">
      <p className="font-mono text-[0.7rem] tracking-[0.18em] text-ink/55 uppercase">
        Figures
      </p>
      <h1 className="mt-4 font-editorial text-3xl tracking-[-0.02em] text-ink sm:text-4xl">
        Blog figures
      </h1>
      <p className="mt-4 max-w-3xl text-ink/70">
        Every diagram from the blog, one page each. The figures are drawn in the
        browser, so each page also carries an exported PNG you can hotlink when
        a post is syndicated somewhere that cannot render them.
      </p>

      <ul className="mt-12 grid grid-cols-1 gap-10 lg:grid-cols-2">
        {allFigures().map((figure) => (
          <li key={figure.id}>
            <Link href={`/figures/${figure.id}`} className="group block">
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
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
