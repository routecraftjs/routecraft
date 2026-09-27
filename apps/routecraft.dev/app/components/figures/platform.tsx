import type { CSSProperties, ReactNode } from 'react'

import { FigureCanvas } from '@/components/figures/primitives'
import type { FigurePalette } from '@/components/figures/palette'
import type {
  FigureDrawing,
  FigureProps,
  MotifProps,
} from '@/components/figures/types'

/** 16:9, the frame the homepage film plays in, so the two can swap. */
const WIDTH = 1600
const HEIGHT = 900

const MONO = 'var(--font-mono)'
const SANS = 'var(--font-sans)'
const EDITORIAL = 'var(--font-editorial)'

/** The board is laid out in its own coordinates and centred on the canvas. */
const BOARD_X = 72
const BOARD_Y = 109

const at = (left: number, top: number): CSSProperties => ({
  position: 'absolute',
  left: BOARD_X + left,
  top: BOARD_Y + top,
})

const SYSTEMS = [
  'CRM',
  'ERP',
  'HR and payroll',
  'ticketing',
  'knowledge base',
  'mail and calendar',
  'chat',
  'source control',
]

function Name({ color, children }: { color?: string; children: ReactNode }) {
  return (
    <span
      style={{
        fontFamily: EDITORIAL,
        fontSize: 30,
        lineHeight: 1.1,
        fontWeight: 500,
        letterSpacing: '-0.01em',
        fontVariationSettings: '"opsz" 72, "SOFT" 30',
        color,
      }}
    >
      {children}
    </span>
  )
}

function Sub({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span style={{ fontFamily: SANS, fontSize: 14, lineHeight: 1.35, color }}>
      {children}
    </span>
  )
}

function Tag({
  palette,
  left,
  top,
  align = 'left',
  accent,
  children,
}: {
  palette: FigurePalette
  left: number
  top: number
  align?: 'left' | 'center' | 'right'
  accent?: boolean
  children: ReactNode
}) {
  const shift = {
    left: 'none',
    center: 'translateX(-50%)',
    right: 'translateX(-100%)',
  }
  return (
    <span
      style={{
        ...at(left, top),
        transform: shift[align],
        fontFamily: MONO,
        fontSize: 11,
        letterSpacing: '0.02em',
        lineHeight: '14px',
        whiteSpace: 'nowrap',
        color: accent ? palette.accent : palette.ink60,
      }}
    >
      {children}
    </span>
  )
}

function Blocks({
  count,
  fill,
  gapAfter,
}: {
  count: number
  fill: string
  gapAfter?: number
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
            marginRight: i === gapAfter ? 24 : 0,
          }}
        />
      ))}
    </div>
  )
}

function Store({ palette }: { palette: FigurePalette }) {
  return (
    <svg
      viewBox="0 0 24 24"
      style={{
        width: 14,
        height: 14,
        flex: 'none',
        fill: 'none',
        stroke: palette.ink60,
        strokeWidth: 1.6,
      }}
    >
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </svg>
  )
}

function Pane({
  left,
  background,
  children,
}: {
  left: number
  background: string
  children: ReactNode
}) {
  return (
    <div
      style={{
        ...at(left, 186),
        width: 570,
        height: 270,
        padding: '28px 24px',
        boxSizing: 'border-box',
        background,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      {children}
    </div>
  )
}

/**
 * The platform at its highest level: every way in across the top, a local
 * harness per person and one team harness in the middle, the organisation's
 * systems along the bottom. Promotion and remotes join the two harnesses;
 * personal credentials leave the laptop, service credentials leave the team
 * harness. Blocks stay unlabelled, because this picture is about where things
 * run, not what they are.
 */
function PlatformFigure({ palette }: FigureProps) {
  const band: CSSProperties = {
    position: 'absolute',
    left: BOARD_X + 78,
    width: 1300,
    boxSizing: 'border-box',
    background: palette.paperDeepSolid,
    display: 'flex',
    alignItems: 'center',
    gap: 24,
    padding: '0 24px',
  }
  const ghost: CSSProperties = {
    width: 570,
    height: 270,
    boxSizing: 'border-box',
    border: `1px dashed ${palette.ink40}`,
  }
  const lab: CSSProperties = {
    flex: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  }

  return (
    <FigureCanvas palette={palette} width={WIDTH} height={HEIGHT}>
      <div style={{ ...band, top: BOARD_Y + 16, height: 110 }}>
        <div style={{ ...lab, width: 340 }}>
          <Name>Every way in</Name>
          <Sub color={palette.ink60}>
            people in their editor, any agent over MCP, the CLI, HTTP, and
            triggers that need nobody
          </Sub>
        </div>
        <Blocks count={9} fill={palette.ink25} gapAfter={3} />
      </div>

      <Tag palette={palette} left={94} top={148}>
        one per person
      </Tag>
      <div style={{ ...at(94, 170), ...ghost }} />
      <div style={{ ...at(86, 178), ...ghost }} />
      <Pane left={78} background={palette.paperDeepSolid}>
        <Name>Local harness</Name>
        <Sub color={palette.ink60}>
          on your laptop, on your own access. Try anything first.
        </Sub>
        <div style={{ marginTop: 'auto' }}>
          <Blocks count={6} fill={palette.ink25} />
        </div>
      </Pane>
      <Pane left={808} background={palette.inverseBg}>
        <Name color={palette.inverseAccent}>Team harness</Name>
        <Sub color={palette.inverseFg}>
          <span style={{ opacity: 0.7 }}>
            always on, on service credentials, every call on record
          </span>
        </Sub>
        <div style={{ marginTop: 'auto' }}>
          <Blocks count={6} fill={palette.inverseFg} />
        </div>
      </Pane>

      <Tag palette={palette} left={736} top={226} align="center">
        promote when proven
      </Tag>
      <Tag palette={palette} left={736} top={280} align="center">
        remote
      </Tag>
      <div
        style={{
          ...at(682, 350),
          width: 108,
          padding: '8px 0',
          boxSizing: 'border-box',
          border: `1px solid ${palette.ink35}`,
          background: palette.paper,
          fontFamily: MONO,
          fontSize: 11,
          lineHeight: '15px',
          textAlign: 'center',
          whiteSpace: 'nowrap',
          color: palette.ink,
        }}
      >
        <span style={{ opacity: 0.8 }}>
          shared as
          <br />
          packages
          <br />
          capabilities,
          <br />
          skills, agents
        </span>
      </div>
      <Tag palette={palette} left={1350} top={149} align="right">
        asks you when it needs a decision
      </Tag>
      <Tag palette={palette} left={375} top={488}>
        personal credentials
      </Tag>
      <Tag palette={palette} left={1105} top={488} accent>
        service credentials
      </Tag>

      <div style={{ ...band, top: BOARD_Y + 536, height: 130 }}>
        <div style={{ ...lab, width: 200 }}>
          <Name>Your systems</Name>
          <Sub color={palette.ink60}>as they are, where they are</Sub>
        </div>
        <div
          style={{
            flex: 1,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 6,
          }}
        >
          {SYSTEMS.map((system) => (
            <span
              key={system}
              style={{
                height: 52,
                padding: '0 10px',
                boxSizing: 'border-box',
                border: `1px solid ${palette.ink25}`,
                background: palette.paper,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontFamily: MONO,
                fontSize: 14,
                whiteSpace: 'nowrap',
              }}
            >
              <Store palette={palette} />
              {system}
            </span>
          ))}
        </div>
      </div>

      <svg
        width={WIDTH}
        height={HEIGHT}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          overflow: 'visible',
          fill: 'none',
          strokeWidth: 1.5,
        }}
      >
        <defs>
          <marker
            id="platform-ink"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            orient="auto-start-reverse"
          >
            <path
              d="M1 1L9 5L1 9"
              fill="none"
              stroke={palette.ink60}
              strokeWidth="1.5"
            />
          </marker>
          <marker
            id="platform-accent"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            orient="auto-start-reverse"
          >
            <path
              d="M1 1L9 5L1 9"
              fill="none"
              stroke={palette.accent}
              strokeWidth="1.5"
            />
          </marker>
        </defs>
        <g
          transform={`translate(${BOARD_X} ${BOARD_Y})`}
          stroke={palette.ink60}
          markerEnd="url(#platform-ink)"
        >
          <line x1="363" y1="126" x2="363" y2="184" />
          <line x1="1093" y1="126" x2="1093" y2="184" />
          <line x1="1360" y1="186" x2="1360" y2="128" />
          <line x1="666" y1="250" x2="806" y2="250" />
          <line x1="682" y1="388" x2="666" y2="388" />
          <line x1="790" y1="388" x2="806" y2="388" />
          <line
            x1="806"
            y1="272"
            x2="666"
            y2="272"
            strokeDasharray="2 5"
            strokeLinecap="round"
          />
          <line x1="363" y1="456" x2="363" y2="534" strokeDasharray="6 5" />
          <line
            x1="1093"
            y1="456"
            x2="1093"
            y2="534"
            stroke={palette.accent}
            markerEnd="url(#platform-accent)"
          />
        </g>
      </svg>
    </FigureCanvas>
  )
}

/**
 * Motif: a band across the top, two harnesses side by side (the team one
 * solid), a band along the bottom, and one accented line down from the team
 * harness to the systems.
 */
function Motif({ palette, size }: MotifProps) {
  const unit = size / 100
  const box = (width: number, height: number, background: string) => (
    <div
      style={{
        width: unit * width,
        height: unit * height,
        backgroundColor: background,
      }}
    />
  )
  return (
    <div
      style={{
        width: size,
        height: size,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: unit * 4,
      }}
    >
      {box(72, 10, palette.muted25)}
      <div style={{ display: 'flex', gap: unit * 6 }}>
        {box(33, 24, palette.muted25)}
        {box(33, 24, palette.fg)}
      </div>
      <div
        style={{
          display: 'flex',
          width: unit * 72,
          justifyContent: 'flex-end',
          paddingRight: unit * 16,
        }}
      >
        {box(1.5, 8, palette.accent)}
      </div>
      {box(72, 10, palette.muted25)}
    </div>
  )
}

export const platform: FigureDrawing = {
  id: 'platform',
  width: WIDTH,
  height: HEIGHT,
  Figure: PlatformFigure,
  Motif,
}
