import clsx from 'clsx'

import { Logo } from '@/components/Logo'
import { COVER_PALETTE_THEMED, pickGlyph } from '@/components/BlogCover'
import { ScaledFrame } from '@/components/ScaledFrame'
import { getFigure } from '@/components/figures'

// Edge of the square a motif is drawn into here. Scaled to the panel by
// ScaledFrame, so the number only sets the drawing's internal proportions.
const MOTIF_SIZE = 440

// A compact brand panel: the post's cover artwork plus the Routecraft lockup,
// on the paper ground. Used where a full cover would not fit and would only
// repeat the adjacent title (e.g. the home "From the field" teaser). The artwork
// matches the post's generated cover, motif for motif and glyph for glyph, so
// the two read as the same post.
export function BlogMark({
  slug,
  tags,
  glyph,
  diagram,
  className,
}: {
  slug: string
  tags?: string[]
  glyph?: string
  /** Figure id, as on the cover. Its motif replaces the glyph when set. */
  diagram?: string
  className?: string
}) {
  const char = pickGlyph(slug, tags, glyph)
  const motif = getFigure(diagram)
  return (
    <div
      className={clsx(
        'relative flex h-full w-full items-center justify-center overflow-hidden bg-paper-deep/50',
        className,
      )}
    >
      {/* Top registration crosses only; the bottom corners hold the lockup. */}
      <RegCross className="top-3 left-3" />
      <RegCross className="top-3 right-3" />

      {motif ? (
        <ScaledFrame
          width={MOTIF_SIZE}
          height={MOTIF_SIZE}
          label={motif.alt}
          className="w-[clamp(8rem,28vw,13rem)]"
        >
          <motif.Motif palette={COVER_PALETTE_THEMED} size={MOTIF_SIZE} />
        </ScaledFrame>
      ) : (
        <span
          aria-hidden="true"
          className="font-editorial text-[clamp(8rem,28vw,13rem)] leading-none text-cobalt-500 italic transition group-hover:text-cobalt-600"
        >
          {char}
        </span>
      )}

      <div className="absolute bottom-4 left-4 flex items-center gap-2 whitespace-nowrap text-ink">
        <Logo className="h-5 w-5" />
        <span
          className="font-editorial text-[0.95rem] leading-none tracking-[-0.02em]"
          style={{ fontVariationSettings: '"opsz" 96' }}
        >
          Routecraft
        </span>
      </div>
    </div>
  )
}

function RegCross({ className }: { className: string }) {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        'pointer-events-none absolute h-2.5 w-2.5 text-ink/30',
        className,
      )}
    >
      <span className="absolute top-1/2 left-0 h-px w-full -translate-y-1/2 bg-current" />
      <span className="absolute top-0 left-1/2 h-full w-px -translate-x-1/2 bg-current" />
    </span>
  )
}
