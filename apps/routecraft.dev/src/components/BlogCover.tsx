import type { CSSProperties, ReactElement } from 'react'

export interface CoverPalette {
  /** Page background. */
  bg: string
  /** Primary type and marks. */
  fg: string
  /** The single accent (glyph, accent word, bullet, hairline). */
  accent: string
  /** Foreground at 25% — faint separators. */
  muted25: string
  /** Foreground at 40% — eyebrow separator, registration crosses. */
  muted40: string
  /** Foreground at 55% — eyebrow label, tag chips. */
  muted55: string
  /** Foreground at 62% — subtitle. */
  muted62: string
}

// Literal palette used for the OG image: Satori resolves real color values,
// not CSS variables. This is the light/paper-deep look.
export const COVER_PALETTE_LIGHT: CoverPalette = {
  bg: '#ece5d2',
  fg: '#22232c',
  accent: '#1247ff',
  muted25: 'rgba(34,35,44,0.25)',
  muted40: 'rgba(34,35,44,0.40)',
  muted55: 'rgba(34,35,44,0.55)',
  muted62: 'rgba(34,35,44,0.62)',
}

// CSS-variable palette used in the browser so the cover follows the site's
// light/dark theme. Variables are defined in tailwind.css (:root and .dark).
export const COVER_PALETTE_THEMED: CoverPalette = {
  bg: 'var(--cover-bg)',
  fg: 'var(--cover-fg)',
  accent: 'var(--cover-accent)',
  muted25: 'rgb(var(--cover-fg-rgb) / 0.25)',
  muted40: 'rgb(var(--cover-fg-rgb) / 0.40)',
  muted55: 'rgb(var(--cover-fg-rgb) / 0.55)',
  muted62: 'rgb(var(--cover-fg-rgb) / 0.62)',
}

// Native dimensions: every cover renders at 1200x630, the OG/Twitter card size.
// Callers that need a different display size wrap it in BlogCoverFrame.
export const COVER_WIDTH = 1200
export const COVER_HEIGHT = 630

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'of',
  'in',
  'on',
  'at',
  'to',
  'for',
  'with',
  'from',
  'by',
  'and',
  'or',
  'as',
  'is',
  'are',
])

function fnv1a(value: string): number {
  let h = 2166136261
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function splitTitle(title: string): {
  prefix: string[]
  accent: string[]
} {
  const cleaned = title.trim().replace(/[.?!]+$/, '')
  const words = cleaned.split(/\s+/).filter(Boolean)
  if (words.length === 0) return { prefix: [], accent: [] }
  if (words.length === 1) return { prefix: [], accent: [words[0] + '.'] }

  let start = words.length - 1
  if (STOPWORDS.has(words[start].toLowerCase()) && start > 0) {
    start -= 1
  }
  const accent = words.slice(start)
  accent[accent.length - 1] = accent[accent.length - 1] + '.'
  return {
    prefix: words.slice(0, start),
    accent,
  }
}

export function pickGlyph(
  slug: string,
  tags: string[] | undefined,
  override?: string,
): string {
  // Manual override wins. Use this when you want a typographic mark
  // (& § ¶ № etc.) or a specific letter that isn't the primary tag.
  if (override && override.length > 0) return override.charAt(0)

  // First letter of the primary tag, uppercased. Meaningful by construction.
  if (tags && tags.length > 0) {
    const firstChar = tags[0].charAt(0).toUpperCase()
    if (/[A-Z]/.test(firstChar)) return firstChar
  }

  // Fallback: first letter of slug
  const firstChar = slug.charAt(0).toUpperCase()
  return /[A-Z0-9]/.test(firstChar) ? firstChar : '§'
}

interface GlyphPlacement {
  fontSize: number
  top: number
  right: number
  rotation: number
  opacity: number
}

const GLYPH_PLACEMENTS: GlyphPlacement[] = [
  // Right bleed, vertically centred
  { fontSize: 560, top: 70, right: -30, rotation: 0, opacity: 0.92 },
  // Contained right: glyph sits inside the frame
  { fontSize: 520, top: 95, right: 10, rotation: 0, opacity: 0.95 },
  // Larger right bleed
  { fontSize: 600, top: 45, right: -60, rotation: 0, opacity: 0.9 },
  // Rotated mark, slight bleed
  { fontSize: 540, top: 80, right: -20, rotation: -3, opacity: 0.9 },
]

function pickPlacement(slug: string): GlyphPlacement {
  const hash = fnv1a(slug + '/placement')
  return GLYPH_PLACEMENTS[hash % GLYPH_PLACEMENTS.length]
}

// Keep subtitle short: trim to the first sentence (or ~120 chars).
function clampSubtitle(text: string): string {
  const firstSentence = text.split(/(?<=[.!?])\s/)[0] ?? text
  if (firstSentence.length <= 120) return firstSentence
  return firstSentence.slice(0, 117).trimEnd() + '…'
}

function titleFontSize(wordCount: number): number {
  if (wordCount <= 4) return 92
  if (wordCount <= 6) return 80
  if (wordCount <= 8) return 68
  if (wordCount <= 10) return 58
  return 52
}

function topicLabel(tags: string[] | undefined): string {
  if (!tags || tags.length === 0) return 'POST'
  return tags
    .slice(0, 2)
    .map((t) => t.toUpperCase())
    .join(' / ')
}

export interface BlogCoverProps {
  title: string
  slug: string
  tags?: string[]
  /** Optional one-line subtitle (use the post's description if available). */
  subtitle?: string
  /** Override the auto-picked cover glyph. First character only. */
  glyph?: string
  /** 1-indexed figure number, ascending by post date. */
  figureNumber?: number
  /**
   * Serif font stack. Defaults to the literal "Fraunces" name that Satori
   * resolves in the OG image. In-page callers pass the next/font CSS variable.
   */
  serifFont?: string
  /** Mono font stack. See {@link serifFont}. */
  monoFont?: string
  /**
   * Colour palette. Defaults to the literal light palette for the OG image.
   * In-page callers pass {@link COVER_PALETTE_THEMED} to follow dark mode.
   */
  palette?: CoverPalette
}

export function BlogCover({
  title,
  slug,
  tags,
  subtitle,
  glyph,
  figureNumber,
  serifFont = '"Fraunces", serif',
  monoFont = '"JetBrains Mono", monospace',
  palette = COVER_PALETTE_LIGHT,
}: BlogCoverProps): ReactElement {
  const { prefix, accent } = splitTitle(title)
  const chosenGlyph = pickGlyph(slug, tags, glyph)
  const placement = pickPlacement(slug)
  const figLabel =
    typeof figureNumber === 'number'
      ? `FIG. ${String(figureNumber).padStart(2, '0')}`
      : 'FIG.'
  const sceneLabel = topicLabel(tags)
  const topTags = (tags ?? []).slice(0, 3).map((t) => t.toUpperCase())
  const fontSize = titleFontSize(prefix.length + accent.length)
  const wordGap = `${fontSize * 0.28}px`

  return (
    <div
      style={{
        width: COVER_WIDTH,
        height: COVER_HEIGHT,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '60px 80px',
        boxSizing: 'border-box',
        backgroundColor: palette.bg,
        color: palette.fg,
        fontFamily: serifFont,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Giant italic letter glyph on the right */}
      <div
        style={{
          position: 'absolute',
          top: placement.top,
          right: placement.right,
          fontFamily: serifFont,
          fontStyle: 'italic',
          fontWeight: 400,
          color: palette.accent,
          fontSize: placement.fontSize,
          lineHeight: 0.78,
          opacity: placement.opacity,
          transform: `rotate(${placement.rotation}deg)`,
          transformOrigin: 'center',
          display: 'flex',
        }}
      >
        {chosenGlyph}
      </div>

      {/* Registration crosses */}
      <RegMark color={palette.muted40} style={{ top: 28, left: 28 }} />
      <RegMark color={palette.muted40} style={{ top: 28, right: 28 }} />
      <RegMark color={palette.muted40} style={{ bottom: 28, left: 28 }} />
      <RegMark color={palette.muted40} style={{ bottom: 28, right: 28 }} />

      {/* Top row: eyebrow */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          fontFamily: monoFont,
          fontSize: 16,
          letterSpacing: '0.22em',
          position: 'relative',
          zIndex: 1,
        }}
      >
        <span
          style={{
            width: 9,
            height: 9,
            backgroundColor: palette.accent,
            display: 'block',
          }}
        />
        <span style={{ color: palette.accent }}>{figLabel}</span>
        <span style={{ color: palette.muted40 }}>·</span>
        <span style={{ color: palette.muted55 }}>{sceneLabel}</span>
      </div>

      {/* Middle: title + subtitle, vertically centered, never overlapping.
          maxWidth keeps text clear of the glyph on the right. */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          justifyContent: 'center',
          maxWidth: 600,
          paddingTop: 24,
          paddingBottom: 24,
          position: 'relative',
          zIndex: 1,
        }}
      >
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            fontFamily: serifFont,
            fontWeight: 400,
            fontSize,
            lineHeight: 1.05,
            letterSpacing: '-0.028em',
            color: palette.fg,
            columnGap: wordGap,
            rowGap: 0,
            alignContent: 'flex-start',
          }}
        >
          {prefix.map((word, i) => (
            <span key={`p-${i}-${word}`} style={{ display: 'flex' }}>
              {word}
            </span>
          ))}
          {accent.map((word, i) => (
            <span
              key={`a-${i}-${word}`}
              style={{
                display: 'flex',
                fontStyle: 'italic',
                color: palette.accent,
              }}
            >
              {word}
            </span>
          ))}
        </div>

        {subtitle && (
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 14,
              marginTop: 28,
            }}
          >
            <span
              style={{
                width: 32,
                height: 1,
                backgroundColor: palette.accent,
                display: 'block',
                flexShrink: 0,
                marginTop: 14,
              }}
            />
            <span
              style={{
                fontFamily: serifFont,
                fontStyle: 'italic',
                fontSize: 20,
                color: palette.muted62,
                lineHeight: 1.4,
                display: 'flex',
              }}
            >
              {clampSubtitle(subtitle)}
            </span>
          </div>
        )}
      </div>

      {/* Bottom row: R lockup + tag chips */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          position: 'relative',
          zIndex: 1,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <RoutecraftLogomark size={30} fill={palette.fg} />
          <span
            style={{
              fontFamily: serifFont,
              fontSize: 28,
              letterSpacing: '-0.025em',
              lineHeight: 1,
              color: palette.fg,
            }}
          >
            Routecraft
          </span>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            fontFamily: monoFont,
            fontSize: 15,
            letterSpacing: '0.22em',
          }}
        >
          {topTags.map((tag, i) => (
            <span
              key={tag}
              style={{ display: 'flex', alignItems: 'center', gap: 14 }}
            >
              {i > 0 && <span style={{ color: palette.muted25 }}>·</span>}
              <span style={{ color: palette.muted55 }}>{tag}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

function RegMark({ style, color }: { style: CSSProperties; color: string }) {
  return (
    <div
      style={{
        position: 'absolute',
        width: 14,
        height: 14,
        display: 'flex',
        ...style,
      }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14">
        <line x1="0" y1="7" x2="14" y2="7" stroke={color} strokeWidth="1" />
        <line x1="7" y1="0" x2="7" y2="14" stroke={color} strokeWidth="1" />
      </svg>
    </div>
  )
}

function RoutecraftLogomark({
  size = 30,
  fill,
}: {
  size?: number
  fill: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 200"
      style={{ display: 'flex' }}
    >
      <path
        d="M125 175H75V125L125 175ZM175 175H125V125L175 175ZM125 25C152.614 25 175 47.3858 175 75C175 102.614 152.614 125 125 125V75H75L125 125H75L25 75V25H125Z"
        fill={fill}
      />
    </svg>
  )
}

// Responsive scaler. Wraps the fixed 1200x630 <BlogCover /> in an SVG with a
// viewBox so the cover scales natively (no JS, no fragile transforms).
//
// Two modes:
//  - default: width 100%, height auto. The SVG defines its own height from the
//    1200:630 ratio. Use when the container matches that aspect (the blog grid
//    cards) or has no fixed height.
//  - fill: the SVG fills its (positioned) parent and crops like
//    `object-fit: cover`, anchored left so the title stays in frame. Use when
//    the container's aspect differs (featured card, home teaser column).
export function BlogCoverFrame({
  children,
  className,
  fill = false,
}: {
  children: React.ReactNode
  className?: string
  fill?: boolean
}) {
  const style: CSSProperties = fill
    ? {
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        display: 'block',
      }
    : { display: 'block', width: '100%', height: 'auto' }
  return (
    <svg
      className={className}
      role="img"
      viewBox={`0 0 ${COVER_WIDTH} ${COVER_HEIGHT}`}
      preserveAspectRatio={fill ? 'xMinYMid slice' : 'xMidYMid meet'}
      style={style}
    >
      <foreignObject x={0} y={0} width={COVER_WIDTH} height={COVER_HEIGHT}>
        {children}
      </foreignObject>
    </svg>
  )
}

// In-page cover: scales responsively and uses the site's next/font families.
// Use this anywhere the cover renders in the browser (hero, cards). The OG
// image path renders <BlogCover /> directly with its literal-name defaults.
export function BlogCoverInline({
  className,
  fill,
  ...props
}: BlogCoverProps & { className?: string; fill?: boolean }) {
  return (
    <BlogCoverFrame
      className={['blog-cover', className].filter(Boolean).join(' ')}
      fill={fill}
    >
      <BlogCover
        {...props}
        serifFont="var(--font-fraunces), serif"
        monoFont="var(--font-jetbrains-mono), monospace"
        palette={COVER_PALETTE_THEMED}
      />
    </BlogCoverFrame>
  )
}
