import type { CSSProperties } from 'react'

import {
  Block,
  Chip,
  DashedPlate,
  Divider,
  Eyebrow,
  FigureCanvas,
  MonoNote,
  Plate,
} from '@/components/figures/primitives'
import type { FigurePalette } from '@/components/figures/palette'
import type {
  FigureDrawing,
  FigureProps,
  MotifProps,
} from '@/components/figures/types'

const WIDTH = 1600
const HEIGHT = 900

const COLUMN: CSSProperties = { display: 'flex', flexDirection: 'column' }

/** A laptop outline: one person's machine, one person's credentials. */
function LaptopMark({ palette }: { palette: FigurePalette }) {
  return (
    <svg
      viewBox="0 0 48 32"
      style={{ width: 58, height: 'auto', stroke: palette.ink, fill: 'none' }}
      strokeWidth={2}
    >
      <rect x="6" y="3" width="36" height="22" rx="2" />
      <path d="M2 30h44" />
    </svg>
  )
}

function SoloAgent({ palette }: { palette: FigurePalette }) {
  return (
    <div
      style={{
        border: `1px solid ${palette.ink15}`,
        background: palette.paperDeep,
        padding: 28,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        opacity: 0.72,
      }}
    >
      <LaptopMark palette={palette} />
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '1.3rem' }}>
        agent
      </span>
      <div style={{ display: 'flex', gap: 6 }}>
        {['key', 'mem'].map((label) => (
          <span
            key={label}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '1rem',
              border: `1px solid ${palette.ink25}`,
              padding: '5px 12px',
            }}
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  )
}

function Figure({ palette }: FigureProps) {
  return (
    <FigureCanvas palette={palette} width={WIDTH} height={HEIGHT}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'grid',
          gridTemplateColumns: 'minmax(0,1fr) 1px minmax(0,1fr)',
          padding: '70px 72px',
        }}
      >
        <div style={{ ...COLUMN, paddingRight: 56 }}>
          <Eyebrow palette={palette}>Single-player</Eyebrow>
          <div
            style={{
              marginTop: 'auto',
              marginBottom: 'auto',
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 26,
            }}
          >
            {Array.from({ length: 6 }, (_, i) => (
              <SoloAgent key={i} palette={palette} />
            ))}
          </div>
          <MonoNote palette={palette} style={{ marginTop: 'auto' }}>
            your accounts · your laptop · your memory · × 40
          </MonoNote>
        </div>

        <Divider palette={palette} vertical />

        <div style={{ ...COLUMN, paddingLeft: 56 }}>
          <Eyebrow palette={palette} accent>
            Multiplayer
          </Eyebrow>
          <div
            style={{
              marginTop: 'auto',
              display: 'flex',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            {['laptop', 'chat', 'phone', 'agent'].map((label) => (
              <Chip
                key={label}
                palette={palette}
                style={{ flex: 1, fontSize: '1.25rem', padding: '20px 8px' }}
              >
                {label}
              </Chip>
            ))}
          </div>
          <div
            style={{
              textAlign: 'center',
              color: palette.ink35,
              fontSize: '1.6rem',
              margin: '12px 0',
            }}
          >
            ↓ &nbsp; ↓ &nbsp; ↓ &nbsp; ↓
          </div>
          <Plate palette={palette}>SSO &nbsp;·&nbsp; FRONT DOOR</Plate>
          <div style={{ marginTop: 24, display: 'flex', gap: 18 }}>
            {[
              'look up open orders',
              'check invoice vs contract',
              'compare record across systems',
            ].map((label) => (
              <Block
                key={label}
                palette={palette}
                style={{
                  flex: 1,
                  height: 190,
                  fontSize: '1.3rem',
                  padding: 12,
                }}
              >
                {label}
              </Block>
            ))}
          </div>
          <DashedPlate palette={palette} style={{ marginTop: 24 }}>
            SERVICE ACCOUNTS &nbsp;·&nbsp; PLATFORM-OWNED
          </DashedPlate>
          <MonoNote palette={palette} accent style={{ marginTop: 'auto' }}>
            one governed capability layer
          </MonoNote>
        </div>
      </div>
    </FigureCanvas>
  )
}

/**
 * Motif: scattered private agents on the left, one shared stack on the right.
 * The whole argument reduced to "many loose boxes" against "one funnel".
 */
function Motif({ palette, size }: MotifProps) {
  const unit = size / 100
  return (
    <div
      style={{
        width: size,
        height: size,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: unit * 9,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: unit * 5,
          opacity: 0.55,
        }}
      >
        {[0, 1, 2].map((row) => (
          <div key={row} style={{ display: 'flex', gap: unit * 5 }}>
            {[0, 1].map((col) => (
              <div
                key={col}
                style={{
                  width: unit * 15,
                  height: unit * 15,
                  border: `${Math.max(2, unit * 1.2)}px solid ${palette.fg}`,
                }}
              />
            ))}
          </div>
        ))}
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: unit * 4,
        }}
      >
        <div style={{ display: 'flex', gap: unit * 3 }}>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{
                width: unit * 9,
                height: unit * 9,
                border: `${Math.max(2, unit * 1.2)}px solid ${palette.muted55}`,
              }}
            />
          ))}
        </div>
        <div
          style={{
            width: unit * 35,
            height: unit * 8,
            backgroundColor: palette.fg,
          }}
        />
        <div style={{ display: 'flex', gap: unit * 3 }}>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{
                width: unit * 9,
                height: unit * 22,
                border: `${Math.max(2, unit * 1.6)}px solid ${palette.accent}`,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

export const singlePlayerVsMultiplayer: FigureDrawing = {
  id: 'single-player-vs-multiplayer',
  width: WIDTH,
  height: HEIGHT,
  Figure,
  Motif,
}
