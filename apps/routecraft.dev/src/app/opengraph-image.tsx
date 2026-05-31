import { ImageResponse } from 'next/og'

import { OG_SIZE, OG_CONTENT_TYPE, ogFonts } from '@/lib/blog-og-image'
import { siteName, siteTagline } from '@/lib/site'

// Default Open Graph image for every route that does not define its own (home,
// docs, cheat-sheet, blog index). Blog posts override this with their cover.
export const size = OG_SIZE
export const contentType = OG_CONTENT_TYPE
export const alt = `${siteName} - ${siteTagline}`
export const dynamic = 'force-static'

const ink = '#22232c'
const paperDeep = '#ebe5da'
const cobalt = '#1247ff'
const logoPath =
  'M125 175H75V125L125 175ZM175 175H125V125L175 175ZM125 25C152.614 25 175 47.3858 175 75C175 102.614 152.614 125 125 125V75H75L125 125H75L25 75V25H125Z'

function Cross({ style }: { style: React.CSSProperties }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      style={{ position: 'absolute', ...style }}
    >
      <line x1="0" y1="7" x2="14" y2="7" stroke={ink} strokeOpacity="0.4" />
      <line x1="7" y1="0" x2="7" y2="14" stroke={ink} strokeOpacity="0.4" />
    </svg>
  )
}

export default async function Image() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        backgroundColor: paperDeep,
        color: ink,
        padding: '64px 72px',
        fontFamily: 'Fraunces',
      }}
    >
      <Cross style={{ top: 28, left: 28 }} />
      <Cross style={{ top: 28, right: 28 }} />
      <Cross style={{ bottom: 28, left: 28 }} />
      <Cross style={{ bottom: 28, right: 28 }} />

      <div
        style={{
          display: 'flex',
          fontFamily: 'JetBrains Mono',
          fontSize: 20,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: cobalt,
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
        <span style={{ display: 'flex' }}>Tools for agents.</span>
        <span style={{ display: 'flex' }}>
          <span style={{ fontStyle: 'italic' }}>Or the</span>
          <span style={{ fontStyle: 'italic', color: cobalt, marginLeft: 18 }}>
            agent itself.
          </span>
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center' }}>
        <svg width="46" height="46" viewBox="0 0 200 200">
          <path d={logoPath} fill={ink} />
        </svg>
        <span
          style={{
            marginLeft: 16,
            fontSize: 40,
            letterSpacing: '-0.02em',
          }}
        >
          {siteName}
        </span>
        <span
          style={{
            marginLeft: 'auto',
            fontFamily: 'JetBrains Mono',
            fontSize: 18,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'rgba(34,35,44,0.55)',
          }}
        >
          {siteTagline}
        </span>
      </div>
    </div>,
    { ...OG_SIZE, fonts: await ogFonts() },
  )
}
