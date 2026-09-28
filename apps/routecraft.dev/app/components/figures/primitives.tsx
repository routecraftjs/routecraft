import type { CSSProperties, ReactNode } from 'react'

import type { FigurePalette } from '@/components/figures/palette'

/**
 * Shared marks for the blog figures. Every figure is drawn on a fixed canvas in
 * the same vocabulary: paper ground, hairline chips, accented capability
 * blocks, and one inverted plate. These are browser-only (the OG image renders
 * a motif, not a figure), so `color-mix` and CSS variables are fair game.
 */

const MONO = 'var(--font-mono)'
const EDITORIAL = 'var(--font-editorial)'

/** The Routecraft logomark, stamped top-right on every figure. */
export function FigureMark({
  palette,
  top = 36,
}: {
  palette: FigurePalette
  top?: number
}) {
  return (
    <svg
      viewBox="0 0 200 200"
      style={{
        position: 'absolute',
        top,
        right: 64,
        width: 34,
        height: 34,
        fill: palette.ink,
        opacity: 0.5,
      }}
    >
      <path d="M125 175H75V125L125 175ZM175 175H125V125L175 175ZM125 25C152.614 25 175 47.3858 175 75C175 102.614 152.614 125 125 125V75H75L125 125H75L25 75V25H125Z" />
    </svg>
  )
}

/** Fixed-canvas ground: paper fill, ink type, logomark. */
export function FigureCanvas({
  palette,
  width,
  height,
  markTop,
  children,
}: {
  palette: FigurePalette
  width: number
  height: number
  markTop?: number
  children: ReactNode
}) {
  return (
    <div
      style={{
        position: 'relative',
        width,
        height,
        overflow: 'hidden',
        background: palette.paper,
        color: palette.ink,
        fontFamily: 'var(--font-sans)',
      }}
    >
      <FigureMark palette={palette} top={markTop} />
      {children}
    </div>
  )
}

/** Mono, letterspaced, uppercase section label. Accented when it names the answer. */
export function Eyebrow({
  palette,
  accent = false,
  children,
  style,
}: {
  palette: FigurePalette
  accent?: boolean
  children: ReactNode
  style?: CSSProperties
}) {
  return (
    <span
      style={{
        fontFamily: MONO,
        fontSize: '1.2rem',
        letterSpacing: '0.22em',
        textTransform: 'uppercase',
        color: accent ? palette.accent : palette.ink55,
        ...style,
      }}
    >
      {children}
    </span>
  )
}

/** Hairline-bordered mono token. The generic "a thing" of these diagrams. */
export function Chip({
  palette,
  children,
  style,
}: {
  palette: FigurePalette
  children: ReactNode
  style?: CSSProperties
}) {
  return (
    <span
      style={{
        fontFamily: MONO,
        letterSpacing: '0.04em',
        border: `1px solid ${palette.ink25}`,
        padding: '14px 22px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        background: palette.paper,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </span>
  )
}

/** Accent-bordered block: a governed capability, as opposed to a loose tool. */
export function Block({
  palette,
  children,
  style,
}: {
  palette: FigurePalette
  children: ReactNode
  style?: CSSProperties
}) {
  return (
    <div
      style={{
        border: `2px solid ${palette.accent}`,
        color: palette.accent,
        fontFamily: MONO,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        ...style,
      }}
    >
      {children}
    </div>
  )
}

/** Inverted plate. Reserved for the one thing everything else routes through. */
export function Plate({
  palette,
  children,
  style,
}: {
  palette: FigurePalette
  children: ReactNode
  style?: CSSProperties
}) {
  return (
    <div
      style={{
        background: palette.inverseBg,
        color: palette.inverseFg,
        textAlign: 'center',
        padding: 20,
        fontFamily: MONO,
        fontSize: '1.3rem',
        letterSpacing: '0.16em',
        ...style,
      }}
    >
      {children}
    </div>
  )
}

/** Dashed plate: a policy that holds, drawn as a boundary rather than a box. */
export function DashedPlate({
  palette,
  children,
  style,
}: {
  palette: FigurePalette
  children: ReactNode
  style?: CSSProperties
}) {
  return (
    <div
      style={{
        border: `1px dashed ${palette.ink40}`,
        textAlign: 'center',
        padding: 20,
        fontFamily: MONO,
        fontSize: '1.3rem',
        letterSpacing: '0.16em',
        color: palette.ink60,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

export function Arrow({
  palette,
  accent = false,
  size = '2.2rem',
  children = '→',
  style,
}: {
  palette: FigurePalette
  accent?: boolean
  size?: string
  children?: ReactNode
  style?: CSSProperties
}) {
  return (
    <span
      style={{
        color: accent ? palette.accent : palette.ink40,
        fontSize: size,
        lineHeight: 1,
        ...style,
      }}
    >
      {children}
    </span>
  )
}

/** The signature mark: a numeral or phrase in cobalt Fraunces italic. */
export function AccentItalic({
  palette,
  size,
  children,
  style,
}: {
  palette: FigurePalette
  size: string
  children: ReactNode
  style?: CSSProperties
}) {
  return (
    <span
      style={{
        fontFamily: EDITORIAL,
        fontStyle: 'italic',
        color: palette.accent,
        fontSize: size,
        fontVariationSettings: '"opsz" 144, "SOFT" 100',
        ...style,
      }}
    >
      {children}
    </span>
  )
}

export function Subhead({
  palette,
  size = '1.7rem',
  accent = false,
  children,
  style,
}: {
  palette: FigurePalette
  size?: string
  accent?: boolean
  children: ReactNode
  style?: CSSProperties
}) {
  return (
    <h4
      style={{
        margin: 0,
        fontFamily: EDITORIAL,
        fontWeight: 500,
        fontSize: size,
        lineHeight: 1.1,
        letterSpacing: '-0.02em',
        fontVariationSettings: '"opsz" 96, "SOFT" 30',
        color: accent ? palette.accent : palette.ink,
        ...style,
      }}
    >
      {children}
    </h4>
  )
}

export function Body({
  palette,
  size = '1.3rem',
  children,
  style,
}: {
  palette: FigurePalette
  size?: string
  children: ReactNode
  style?: CSSProperties
}) {
  return (
    <p
      style={{
        margin: 0,
        fontFamily: 'var(--font-sans)',
        fontSize: size,
        lineHeight: 1.5,
        color: palette.ink60,
        ...style,
      }}
    >
      {children}
    </p>
  )
}

/** Mono caption, usually the line that states the figure's conclusion. */
export function MonoNote({
  palette,
  accent = false,
  size = '1.35rem',
  children,
  style,
}: {
  palette: FigurePalette
  accent?: boolean
  size?: string
  children: ReactNode
  style?: CSSProperties
}) {
  return (
    <p
      style={{
        margin: 0,
        fontFamily: MONO,
        fontSize: size,
        color: accent ? palette.accent : palette.ink55,
        ...style,
      }}
    >
      {children}
    </p>
  )
}

export function Divider({
  palette,
  vertical = false,
}: {
  palette: FigurePalette
  vertical?: boolean
}) {
  return (
    <div
      style={
        vertical
          ? { background: palette.ink15, width: 1 }
          : { background: palette.ink15, height: 1 }
      }
    />
  )
}

/** A data store: the cylinder that stands for a system the organisation already has. */
export function StoreMark({
  colour,
  size = 22,
}: {
  colour: string
  size?: number
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      style={{
        width: size,
        height: size,
        flex: 'none',
        stroke: colour,
        fill: 'none',
      }}
      strokeWidth={1.6}
    >
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </svg>
  )
}

/** The figure's closing line under a hairline, its last clause in the accent. */
export function Conclusion({
  palette,
  accent,
  children,
  style,
}: {
  palette: FigurePalette
  accent: ReactNode
  children: ReactNode
  style?: CSSProperties
}) {
  return (
    <p
      style={{
        margin: 0,
        textAlign: 'center',
        fontFamily: EDITORIAL,
        fontStyle: 'italic',
        fontSize: '1.8rem',
        lineHeight: 1.45,
        color: palette.ink60,
        borderTop: `1px solid ${palette.ink15}`,
        paddingTop: 32,
        fontVariationSettings: '"opsz" 96, "SOFT" 60',
        ...style,
      }}
    >
      {children} <span style={{ color: palette.accent }}>{accent}</span>
    </p>
  )
}

/** A platform layer's name, as the platform figures label their bands and panes. */
export function LayerName({
  colour,
  children,
}: {
  colour?: string
  children: ReactNode
}) {
  return (
    <span
      style={{
        fontFamily: EDITORIAL,
        fontSize: 30,
        lineHeight: 1.1,
        fontWeight: 500,
        letterSpacing: '-0.01em',
        fontVariationSettings: '"opsz" 72, "SOFT" 30',
        color: colour,
      }}
    >
      {children}
    </span>
  )
}

export function LayerSub({
  colour,
  children,
}: {
  colour: string
  children: ReactNode
}) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-sans)',
        fontSize: 14,
        lineHeight: 1.35,
        color: colour,
      }}
    >
      {children}
    </span>
  )
}

/**
 * A layer's unlabelled blocks: how much of the layer there is, not what it
 * is. `gapAfter` sets one block apart from the ones after it.
 */
export function BlockRow({
  count,
  fill,
  gapAfter,
  children,
}: {
  count: number
  fill: string
  gapAfter?: number
  children?: ReactNode
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 34 }}>
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          style={{
            width: 44,
            height: 44,
            flex: 'none',
            background: fill,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: i === gapAfter ? 24 : 0,
          }}
        >
          {children}
        </span>
      ))}
    </div>
  )
}
