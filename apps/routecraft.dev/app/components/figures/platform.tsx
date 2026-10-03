import type { CSSProperties, ReactNode } from 'react'

import {
  ArrowheadMarker,
  BlockRow,
  FigureCanvas,
  LayerName,
  LayerSub,
  MONO,
  StoreMark,
} from '@/components/figures/primitives'
import type { FigurePalette } from '@/components/figures/palette'
import type {
  FigureDrawing,
  FigureProps,
  MotifProps,
} from '@/components/figures/types'

/** 16:9, the frame the homepage film plays in, so the two can swap. */
const WIDTH = 1600
const HEIGHT = 900

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
  'support desk',
  'knowledge base',
  'mail and calendar',
  'chat',
  'source control',
]

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
          <LayerName>Every way in</LayerName>
          <LayerSub colour={palette.ink60}>
            people in their editor, any agent over MCP, the CLI, HTTP, and
            triggers that need nobody
          </LayerSub>
        </div>
        <BlockRow count={9} fill={palette.ink25} gapAfter={3} />
      </div>

      <Tag palette={palette} left={94} top={148}>
        one per person
      </Tag>
      <div style={{ ...at(94, 170), ...ghost }} />
      <div style={{ ...at(86, 178), ...ghost }} />
      <Pane left={78} background={palette.paperDeepSolid}>
        <LayerName>Local harness</LayerName>
        <LayerSub colour={palette.ink60}>
          on your laptop, on your own access. Try anything first.
        </LayerSub>
        <div style={{ marginTop: 'auto' }}>
          <BlockRow count={6} fill={palette.ink25} />
        </div>
      </Pane>
      <Pane left={808} background={palette.inverseBg}>
        <LayerName colour={palette.inverseAccent}>Team harness</LayerName>
        <LayerSub colour={palette.inverseFg}>
          <span style={{ opacity: 0.7 }}>
            always on, on service credentials, every call on record
          </span>
        </LayerSub>
        <div style={{ marginTop: 'auto' }}>
          <BlockRow count={6} fill={palette.inverseFg} />
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
          <LayerName>Your systems</LayerName>
          <LayerSub colour={palette.ink60}>
            as they are, where they are
          </LayerSub>
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
              <StoreMark colour={palette.ink60} size={14} />
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
          <ArrowheadMarker id="platform-ink" colour={palette.ink60} />
          <ArrowheadMarker id="platform-accent" colour={palette.accent} />
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
