import type { ReactNode } from 'react'

export const HEADLINE_SOFT = '"opsz" 144, "SOFT" 30'
export const HEADLINE_ITALIC = '"opsz" 144, "SOFT" 100'

/**
 * A homepage section's editorial heading: a plain lead, an italic cobalt
 * accent, and an optional intro paragraph beneath.
 */
export function SectionHeading({
  plain,
  accent,
  children,
}: {
  plain: string
  accent: string
  children?: ReactNode
}) {
  return (
    <header className="max-w-3xl">
      <h2
        className="font-editorial text-[2.5rem] leading-[1.05] tracking-[-0.02em] text-ink"
        style={{ fontVariationSettings: HEADLINE_SOFT }}
      >
        {plain}{' '}
        <span
          className="text-cobalt-500 italic"
          style={{ fontVariationSettings: HEADLINE_ITALIC }}
        >
          {accent}
        </span>
      </h2>
      {children ? (
        <p className="mt-5 max-w-2xl text-[1.05rem] leading-[1.75] text-ink/70">
          {children}
        </p>
      ) : null}
    </header>
  )
}
