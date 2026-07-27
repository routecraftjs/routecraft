import { Fragment } from 'react'

import {
  AccentItalic,
  Arrow,
  Body,
  Chip,
  Eyebrow,
  FigureCanvas,
  Plate,
  Subhead,
} from '@/components/figures/primitives'
import type { FigurePalette } from '@/components/figures/palette'
import type {
  FigureDefinition,
  FigureProps,
  MotifProps,
} from '@/components/figures/types'

const WIDTH = 1100
const HEIGHT = 1200

interface Gate {
  n: number
  title: string
  body: string
  /** The gate carrying the worked example, drawn with the accent border. */
  rejects?: string
}

const GATES: Gate[] = [
  { n: 1, title: 'Input', body: 'malformed input never reaches you' },
  {
    n: 2,
    title: 'Rules',
    body: 'business rules as code',
    rejects: 'recipient outside\ncompany domain',
  },
  { n: 3, title: 'Identity', body: 'who is asking, and may they act' },
  {
    n: 4,
    title: 'Declared intent',
    body: 'destructive is labelled in code, so the caller can confirm',
  },
]

function Gate({ gate, palette }: { gate: Gate; palette: FigurePalette }) {
  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        border: `2px solid ${gate.rejects ? palette.accent : palette.ink25}`,
        padding: '28px 36px',
        display: 'flex',
        alignItems: 'baseline',
        gap: 26,
      }}
    >
      <AccentItalic palette={palette} size="1.9rem">
        {gate.n}
      </AccentItalic>
      <div>
        <Subhead palette={palette} size="1.85rem">
          {gate.title}
        </Subhead>
        <Body palette={palette} size="1.45rem">
          {gate.body}
        </Body>
      </div>
      {gate.rejects && (
        <div
          style={{
            position: 'absolute',
            left: -12,
            top: '50%',
            transform: 'translate(-100%, -50%)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            whiteSpace: 'nowrap',
            textAlign: 'right',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.9rem',
              color: palette.accent,
            }}
          >
            {gate.rejects.split('\n').map((line) => (
              <span key={line} style={{ display: 'block' }}>
                {line}
              </span>
            ))}
          </span>
          <Arrow palette={palette} accent size="1.4rem">
            ↪
          </Arrow>
        </div>
      )}
    </div>
  )
}

function Figure({ palette }: FigureProps) {
  return (
    <FigureCanvas palette={palette} width={WIDTH} height={HEIGHT} markTop={54}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          padding: '64px 80px',
        }}
      >
        <Eyebrow palette={palette} accent>
          Every agent-facing tool needs four gates
        </Eyebrow>
        <div
          style={{
            width: 690,
            margin: '32px auto 0',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 16,
          }}
        >
          <Chip palette={palette} style={{ fontSize: '1.4rem' }}>
            tool call
          </Chip>
          {GATES.map((gate) => (
            <Fragment key={gate.n}>
              <Arrow palette={palette} size="1.7rem">
                ↓
              </Arrow>
              <Gate gate={gate} palette={palette} />
            </Fragment>
          ))}
          <Arrow palette={palette} size="1.7rem">
            ↓
          </Arrow>
          <Plate
            palette={palette}
            style={{
              width: '100%',
              padding: 28,
              fontSize: '1.4rem',
              letterSpacing: '0.14em',
            }}
          >
            YOUR LOGIC
          </Plate>
        </div>
      </div>
    </FigureCanvas>
  )
}

/**
 * Motif: the call falls through four gates into an inverted plate. Only the
 * rules gate is accented, matching the figure's worked rejection.
 */
function Motif({ palette, size }: MotifProps) {
  const unit = size / 100
  const stroke = Math.max(2, unit * 1.2)
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
      {[1, 2, 3, 4].map((n) => (
        <div
          key={n}
          style={{
            width: unit * 62,
            height: unit * 13,
            border: `${n === 2 ? stroke * 1.6 : stroke}px solid ${
              n === 2 ? palette.accent : palette.muted55
            }`,
          }}
        />
      ))}
      <div
        style={{
          width: unit * 62,
          height: unit * 13,
          backgroundColor: palette.fg,
        }}
      />
    </div>
  )
}

export const fourGates: FigureDefinition = {
  id: 'four-gates',
  alt: 'A tool call falling through four stacked gates in order: input, rules, identity and declared intent. The rules gate diverts a call whose recipient is outside the company domain. What survives all four reaches your logic.',
  caption: 'The four gates every agent-facing tool runs on every call.',
  width: WIDTH,
  height: HEIGHT,
  Figure,
  Motif,
}
