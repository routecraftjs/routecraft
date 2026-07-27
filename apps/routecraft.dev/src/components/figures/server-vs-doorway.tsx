import type { CSSProperties } from 'react'

import {
  Arrow,
  Block,
  Chip,
  Divider,
  Eyebrow,
  FigureCanvas,
} from '@/components/figures/primitives'
import type {
  FigureDefinition,
  FigureProps,
  MotifProps,
} from '@/components/figures/types'

const WIDTH = 1600
const HEIGHT = 900

const COLUMN: CSSProperties = { display: 'flex', flexDirection: 'column' }
const MONO_SM: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: '0.95rem',
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
        <div
          style={{
            flex: 1,
            display: 'grid',
            gridTemplateColumns: '1fr 1px 1fr',
          }}
        >
          <div style={{ ...COLUMN, paddingRight: 56 }}>
            <Eyebrow palette={palette}>FastMCP</Eyebrow>
            <div
              style={{
                marginTop: 'auto',
                marginBottom: 'auto',
                display: 'flex',
                alignItems: 'center',
                gap: 28,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <Chip palette={palette} style={{ fontSize: '1rem' }}>
                  agent
                </Chip>
                <Arrow palette={palette} size="1.5rem" />
              </div>
              <div
                style={{
                  flex: 1,
                  border: `2px solid ${palette.ink35}`,
                  padding: 30,
                }}
              >
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '1.05rem',
                    letterSpacing: '0.16em',
                    color: palette.ink55,
                  }}
                >
                  MCP SERVER
                </div>
                <div
                  style={{
                    marginTop: 20,
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 12,
                  }}
                >
                  {[0, 1, 2].map((i) => (
                    <Chip
                      key={i}
                      palette={palette}
                      style={{ fontSize: '0.9rem' }}
                    >
                      tool
                    </Chip>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <Divider palette={palette} vertical />

          <div style={{ ...COLUMN, paddingLeft: 56 }}>
            <Eyebrow palette={palette} accent>
              Routecraft
            </Eyebrow>
            <div
              style={{
                marginTop: 'auto',
                marginBottom: 'auto',
                display: 'flex',
                alignItems: 'center',
                gap: 18,
              }}
            >
              <div
                style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
              >
                {['MCP', 'cron', 'HTTP'].map((label) => (
                  <Chip
                    key={label}
                    palette={palette}
                    style={{ fontSize: '0.9rem' }}
                  >
                    {label}
                  </Chip>
                ))}
              </div>
              <Arrow palette={palette} size="1.5rem" />
              <Block
                palette={palette}
                style={{ width: 200, height: 150, fontSize: '1.2rem' }}
              >
                capability
              </Block>
              <div
                style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
              >
                {['call other MCP servers', 'host the agent'].map((label) => (
                  <div
                    key={label}
                    style={{ display: 'flex', alignItems: 'center', gap: 10 }}
                  >
                    <Arrow palette={palette} accent size="1.5rem" />
                    <span style={MONO_SM}>{label}</span>
                  </div>
                ))}
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
          Is the MCP server the product, or{' '}
          <span style={{ color: palette.accent }}>
            one doorway into the product?
          </span>
        </p>
      </div>
    </FigureCanvas>
  )
}

/**
 * Motif: a closed box with tools inside, against a capability that several
 * doorways lead into and that reaches back out.
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
        alignItems: 'center',
        justifyContent: 'center',
        gap: unit * 8,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: unit * 4,
          width: unit * 30,
          height: unit * 40,
          padding: unit * 5,
          border: `${stroke}px solid ${palette.muted55}`,
          opacity: 0.6,
        }}
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            style={{
              height: unit * 6,
              border: `${Math.max(1, unit * 0.8)}px solid ${palette.muted55}`,
            }}
          />
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: unit * 3 }}>
        <div
          style={{ display: 'flex', flexDirection: 'column', gap: unit * 3 }}
        >
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{
                width: unit * 8,
                height: unit * 8,
                border: `${Math.max(1, unit * 0.8)}px solid ${palette.muted55}`,
              }}
            />
          ))}
        </div>
        <div
          style={{
            width: unit * 26,
            height: unit * 34,
            border: `${stroke * 1.6}px solid ${palette.accent}`,
          }}
        />
      </div>
    </div>
  )
}

export const serverVsDoorway: FigureDefinition = {
  id: 'server-vs-doorway',
  alt: 'Left: an agent calling an MCP server that holds three tools. Right: MCP, cron and HTTP all entering one Routecraft capability, which in turn calls other MCP servers and hosts the agent.',
  caption: 'Is the MCP server the product, or one doorway into the product?',
  width: WIDTH,
  height: HEIGHT,
  Figure,
  Motif,
}
