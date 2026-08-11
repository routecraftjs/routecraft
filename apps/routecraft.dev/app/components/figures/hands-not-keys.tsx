import type { CSSProperties } from 'react'

import {
  Arrow,
  Chip,
  Divider,
  Eyebrow,
  FigureCanvas,
  MonoNote,
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

/** The keyring: one credential, everything behind it. */
function KeyMark({ palette }: { palette: FigurePalette }) {
  return (
    <svg
      viewBox="0 0 64 32"
      style={{ width: 100, height: 'auto', stroke: palette.ink, fill: 'none' }}
      strokeWidth={2}
    >
      <circle cx="12" cy="16" r="9" />
      <path d="M21 16h34M48 16v8M40 16v6" />
    </svg>
  )
}

/** The door the key opens. */
function DoorMark({ palette }: { palette: FigurePalette }) {
  return (
    <svg
      viewBox="0 0 40 64"
      style={{ width: 84, height: 'auto', stroke: palette.ink, fill: 'none' }}
      strokeWidth={2}
    >
      <path d="M4 60V6a2 2 0 0 1 2-2h28a2 2 0 0 1 2 2v54" />
      <circle cx="29" cy="34" r="2.4" fill={palette.ink} stroke="none" />
    </svg>
  )
}

/** One bounded hand: a named tool with its four gates stacked underneath. */
function Hand({ palette, name }: { palette: FigurePalette; name: string }) {
  return (
    <div
      style={{
        flex: 1,
        border: `2px solid ${palette.accent}`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          padding: '22px 8px',
          textAlign: 'center',
          fontFamily: 'var(--font-mono)',
          fontSize: '1.05rem',
          color: palette.accent,
          borderBottom: `1px solid ${palette.accent40}`,
        }}
      >
        {name}
      </div>
      {['input', 'policy', 'identity', 'intent'].map((gate, i, all) => (
        <div
          key={gate}
          style={{
            padding: '20px 8px',
            textAlign: 'center',
            fontFamily: 'var(--font-mono)',
            fontSize: '1.15rem',
            color: palette.ink60,
            borderBottom:
              i === all.length - 1 ? undefined : `1px solid ${palette.ink15}`,
          }}
        >
          {gate}
        </div>
      ))}
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
          <Eyebrow palette={palette}>Keys</Eyebrow>
          <div
            style={{
              marginTop: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 24,
              opacity: 0.82,
            }}
          >
            <Chip palette={palette} style={{ fontSize: '1.3rem', padding: 22 }}>
              agent
            </Chip>
            <KeyMark palette={palette} />
            <Arrow palette={palette} />
            <DoorMark palette={palette} />
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 16,
              }}
            >
              {['database', 'email', 'deploy', 'payments'].map((label) => (
                <Chip
                  key={label}
                  palette={palette}
                  style={{ fontSize: '1.15rem', padding: '18px 14px' }}
                >
                  {label}
                </Chip>
              ))}
            </div>
          </div>
          <MonoNote palette={palette} style={{ marginTop: 'auto' }}>
            can do everything the credential can do
          </MonoNote>
        </div>

        <Divider palette={palette} vertical />

        <div style={{ ...COLUMN, paddingLeft: 56 }}>
          <Eyebrow palette={palette} accent>
            Hands
          </Eyebrow>
          <div
            style={{
              marginTop: 'auto',
              marginBottom: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 28,
            }}
          >
            <Chip palette={palette} style={{ fontSize: '1.3rem', padding: 22 }}>
              agent
            </Chip>
            <Arrow palette={palette} />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', gap: 20 }}>
              <Hand palette={palette} name="send_company_email" />
              <Hand palette={palette} name="look_up_record" />
            </div>
          </div>
          <MonoNote palette={palette} accent>
            can press the buttons you built; cannot build new buttons
          </MonoNote>
        </div>
      </div>
    </FigureCanvas>
  )
}

/**
 * Motif: a keyring against two bounded hands. The key opens one shape that
 * leads everywhere; the hands are shapes with edges.
 */
function Motif({ palette, size }: MotifProps) {
  const unit = size / 100
  const stroke = Math.max(2, unit * 1.4)
  return (
    <div
      style={{
        width: size,
        height: size,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: unit * 10,
      }}
    >
      {/* The box matches the 2:1 viewBox, so the key draws at full width and
          holds its own against the hands beside it. */}
      <svg
        width={unit * 34}
        height={unit * 17}
        viewBox="0 0 64 32"
        style={{ opacity: 0.5 }}
      >
        <circle
          cx="12"
          cy="16"
          r="9"
          stroke={palette.fg}
          strokeWidth="2.4"
          fill="none"
        />
        <path
          d="M21 16h34M48 16v8M40 16v6"
          stroke={palette.fg}
          strokeWidth="2.4"
          fill="none"
        />
      </svg>

      <div style={{ display: 'flex', gap: unit * 5 }}>
        {[0, 1].map((col) => (
          <div
            key={col}
            style={{
              display: 'flex',
              flexDirection: 'column',
              width: unit * 17,
              border: `${stroke}px solid ${palette.accent}`,
            }}
          >
            {[0, 1, 2, 3].map((row) => (
              <div
                key={row}
                style={{
                  height: unit * 11,
                  // `none`, not `undefined`. React drops an undefined style
                  // value before it reaches the DOM, so the browser-only `Hand`
                  // above can use it, but Satori parses the property either way
                  // and throws on the undefined. Do not "fix" this to match.
                  borderBottom:
                    row === 3
                      ? 'none'
                      : `${Math.max(1, unit * 0.6)}px solid ${palette.muted25}`,
                }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

export const handsNotKeys: FigureDrawing = {
  id: 'hands-not-keys',
  width: WIDTH,
  height: HEIGHT,
  Figure,
  Motif,
}
