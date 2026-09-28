import type { CSSProperties } from 'react'

import {
  AccentItalic,
  Arrow,
  Block,
  Chip,
  Eyebrow,
  FigureCanvas,
  MonoNote,
  Plate,
} from '@/components/figures/primitives'
import type {
  FigureDrawing,
  FigureProps,
  MotifProps,
} from '@/components/figures/types'

const WIDTH = 1600
const HEIGHT = 900

const MONO: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: '1rem',
  letterSpacing: '0.04em',
}

function Figure({ palette }: FigureProps) {
  return (
    <FigureCanvas palette={palette} width={WIDTH} height={HEIGHT}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          padding: '70px 72px 56px',
        }}
      >
        <Eyebrow palette={palette} accent>
          One question, two paths
        </Eyebrow>

        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 26,
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <Chip palette={palette} style={{ fontSize: '1.05rem' }}>
              agent result
            </Chip>
            <span
              style={{ ...MONO, color: palette.ink55, fontSize: '0.85rem' }}
            >
              request · account · tool record
            </span>
          </div>

          <Arrow palette={palette} size="1.6rem" />

          <Block
            palette={palette}
            style={{
              width: 300,
              height: 190,
              flexDirection: 'column',
              gap: 16,
              padding: 24,
            }}
          >
            <span style={{ fontSize: '1.3rem', letterSpacing: '0.16em' }}>
              JEV SCREEN
            </span>
            <span style={{ ...MONO, color: palette.ink60 }}>
              noul: was the request met?
            </span>
            <span style={{ ...MONO, color: palette.ink60 }}>
              p = 0.00 … 1.00
            </span>
          </Block>

          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              gap: 44,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
              <Arrow palette={palette} accent size="1.6rem" />
              <div style={{ width: 250 }}>
                <MonoNote palette={palette} accent size="1.05rem">
                  p ≥ passAt
                </MonoNote>
              </div>
              <Plate
                palette={palette}
                style={{
                  flex: 1,
                  padding: '26px 20px',
                  fontSize: '1.25rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <span>PASS</span>
                <span
                  style={{
                    ...MONO,
                    fontSize: '0.85rem',
                    letterSpacing: '0.06em',
                    opacity: 0.7,
                  }}
                >
                  no reasoning call
                </span>
              </Plate>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
              <Arrow palette={palette} size="1.6rem" />
              <div style={{ width: 250 }}>
                <MonoNote palette={palette} size="1.05rem">
                  below passAt,
                </MonoNote>
                <MonoNote palette={palette} size="1.05rem">
                  or no answer
                </MonoNote>
              </div>
              <div
                style={{
                  flex: 1,
                  border: `2px solid ${palette.ink35}`,
                  padding: '22px 20px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '1.25rem',
                    letterSpacing: '0.16em',
                    color: palette.ink,
                  }}
                >
                  LLM JUDGE
                </span>
                <span style={{ ...MONO, color: palette.ink60 }}>
                  verdict + reason
                </span>
              </div>
            </div>
          </div>
        </div>

        <p
          style={{
            margin: 0,
            textAlign: 'center',
            fontFamily: 'var(--font-editorial)',
            fontStyle: 'italic',
            fontSize: '1.8rem',
            lineHeight: 1.45,
            color: palette.ink60,
            borderTop: `1px solid ${palette.ink15}`,
            paddingTop: 32,
            fontVariationSettings: '"opsz" 96, "SOFT" 60',
          }}
        >
          The caller sets{' '}
          <AccentItalic palette={palette} size="1.8rem">
            passAt
          </AccentItalic>
          . A confident yes skips the reasoning call; everything else gets a
          sentence.
        </p>
      </div>
    </FigureCanvas>
  )
}

/**
 * Motif: a result enters an accented screen and leaves on one of two rails,
 * the short one ending in a filled plate (the pass) and the long one in an
 * outlined box (the judge that still has to be asked).
 */
function Motif({ palette, size }: MotifProps) {
  const unit = size / 100
  const stroke = Math.max(2, unit * 1.2)
  const rail = (width: number) => (
    <div
      style={{
        width: unit * width,
        height: Math.max(1, unit * 0.9),
        backgroundColor: palette.muted55,
      }}
    />
  )
  return (
    <div
      style={{
        width: size,
        height: size,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: unit * 12,
          height: unit * 12,
          border: `${stroke}px solid ${palette.muted55}`,
        }}
      />
      {rail(8)}
      <div
        style={{
          width: unit * 24,
          height: unit * 30,
          border: `${stroke * 1.6}px solid ${palette.accent}`,
        }}
      />
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: unit * 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {rail(8)}
          <div
            style={{
              width: unit * 22,
              height: unit * 12,
              backgroundColor: palette.fg,
            }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {rail(18)}
          <div
            style={{
              width: unit * 22,
              height: unit * 16,
              border: `${stroke}px solid ${palette.muted55}`,
            }}
          />
        </div>
      </div>
    </div>
  )
}

export const jevScreenCascade: FigureDrawing = {
  id: 'jev-screen-cascade',
  width: WIDTH,
  height: HEIGHT,
  Figure,
  Motif,
}
