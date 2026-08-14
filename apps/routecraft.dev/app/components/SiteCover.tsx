import type { CSSProperties, ReactElement } from 'react'

import {
  COVER_HEIGHT,
  COVER_PALETTE_LIGHT,
  COVER_WIDTH,
} from '@/components/BlogCover'
import { siteName, siteTagline } from '@/lib/site'

/**
 * The site's default social card: the cover every route that does not carry its
 * own uses (home, docs, cheat sheet, blog index). Blog posts override it with
 * {@link BlogCover}.
 *
 * Rendered only by `scripts/generate-og-images.ts`, through Satori, which
 * resolves literal colour values and font names rather than CSS variables. That
 * is why the palette is the literal light one and the font families are spelled
 * out.
 */
export function SiteCover(): ReactElement {
  const { bg, fg, accent, muted40, muted55 } = COVER_PALETTE_LIGHT

  return (
    <div
      style={{
        width: COVER_WIDTH,
        height: COVER_HEIGHT,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        backgroundColor: bg,
        color: fg,
        padding: '64px 72px',
        fontFamily: '"Fraunces", serif',
      }}
    >
      <Cross color={muted40} style={{ top: 28, left: 28 }} />
      <Cross color={muted40} style={{ top: 28, right: 28 }} />
      <Cross color={muted40} style={{ bottom: 28, left: 28 }} />
      <Cross color={muted40} style={{ bottom: 28, right: 28 }} />

      <div
        style={{
          display: 'flex',
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 20,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: accent,
        }}
      >
        routecraft.dev
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          fontSize: 92,
          lineHeight: 1.02,
          letterSpacing: '-0.025em',
        }}
      >
        <span style={{ display: 'flex' }}>
          <span>Tools for</span>
          <span style={{ color: accent, marginLeft: 24 }}>agents</span>
          <span>.</span>
        </span>
        <span style={{ display: 'flex' }}>
          <span style={{ fontStyle: 'italic' }}>Or the</span>
          <span style={{ fontStyle: 'italic', color: accent, marginLeft: 18 }}>
            agent harness
          </span>
          <span style={{ marginLeft: 18 }}>itself.</span>
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center' }}>
        <svg width="46" height="46" viewBox="0 0 200 200">
          <path
            d="M125 175H75V125L125 175ZM175 175H125V125L175 175ZM125 25C152.614 25 175 47.3858 175 75C175 102.614 152.614 125 125 125V75H75L125 125H75L25 75V25H125Z"
            fill={fg}
          />
        </svg>
        <span
          style={{ marginLeft: 16, fontSize: 40, letterSpacing: '-0.02em' }}
        >
          {siteName}
        </span>
        <span
          style={{
            marginLeft: 'auto',
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 18,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: muted55,
          }}
        >
          {siteTagline}
        </span>
      </div>
    </div>
  )
}

/** Registration cross, matching the ones on the blog cover. */
function Cross({ style, color }: { style: CSSProperties; color: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      style={{ position: 'absolute', ...style }}
    >
      <line x1="0" y1="7" x2="14" y2="7" stroke={color} strokeWidth="1" />
      <line x1="7" y1="0" x2="7" y2="14" stroke={color} strokeWidth="1" />
    </svg>
  )
}
