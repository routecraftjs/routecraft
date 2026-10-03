import type { CSSProperties, ReactNode } from 'react'

import {
  ArrowheadMarker,
  Conclusion,
  EDITORIAL,
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

const WIDTH = 1600
const HEIGHT = 1500

const at = (left: number, top: number): CSSProperties => ({
  position: 'absolute',
  left,
  top,
})

const ASKED = [
  'your editor, over ACP',
  'any MCP client',
  'the CLI: run, exec',
  'HTTP',
]

const UNASKED = [
  'cron and timers',
  'webhooks',
  'mail arriving',
  'runtime events',
  'files landing',
  'a parked task resuming',
]

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

function LockMark({ colour }: { colour: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      style={{
        width: 13,
        height: 13,
        flex: 'none',
        stroke: colour,
        fill: 'none',
      }}
      strokeWidth={1.6}
    >
      <rect x="5" y="11" width="14" height="10" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}

function Tile({
  palette,
  border,
  padding = '0 8px',
  center,
  children,
}: {
  palette: FigurePalette
  border?: string
  padding?: string
  center?: boolean
  children: ReactNode
}) {
  return (
    <span
      style={{
        height: 38,
        padding,
        boxSizing: 'border-box',
        border: `1px solid ${border ?? palette.ink25}`,
        background: palette.paper,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: center ? 'center' : undefined,
        gap: 6,
        fontFamily: MONO,
        fontSize: 13,
        whiteSpace: 'nowrap',
        color: palette.ink,
      }}
    >
      {children}
    </span>
  )
}

function Label({
  palette,
  style,
  children,
}: {
  palette: FigurePalette
  style?: CSSProperties
  children: ReactNode
}) {
  return (
    <span
      style={{
        fontFamily: MONO,
        fontSize: 10.5,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        lineHeight: '12px',
        whiteSpace: 'nowrap',
        color: palette.ink55,
        ...style,
      }}
    >
      {children}
    </span>
  )
}

function Tag({
  palette,
  style,
  accent,
  children,
}: {
  palette: FigurePalette
  style: CSSProperties
  accent?: boolean
  children: ReactNode
}) {
  return (
    <span
      style={{
        position: 'absolute',
        fontFamily: MONO,
        fontSize: 11,
        letterSpacing: '0.02em',
        lineHeight: '15px',
        whiteSpace: 'nowrap',
        color: accent ? palette.accent : palette.ink60,
        ...style,
      }}
    >
      {children}
    </span>
  )
}

/** One row of the drawer: its label on the left, its lines of tiles beside it. */
function DrawerRow({
  palette,
  label,
  first,
  children,
}: {
  palette: FigurePalette
  label: string
  first?: boolean
  children: ReactNode
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 16,
        padding: first ? '0 0 10px' : '10px 0',
        borderTop: first ? 'none' : `1px solid ${palette.ink15}`,
      }}
    >
      <Label
        palette={palette}
        style={{
          width: 140,
          flex: 'none',
          paddingTop: 13,
          whiteSpace: 'normal',
          lineHeight: '15px',
        }}
      >
        {label}
      </Label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {children}
      </div>
    </div>
  )
}

function Line({
  gap = 8,
  indent,
  children,
}: {
  gap?: number
  indent?: number
  children: ReactNode
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap,
        paddingLeft: indent,
      }}
    >
      {children}
    </div>
  )
}

/**
 * The platform figure opened up for the docs. The same frame as `platform`
 * (every way in, a local harness per person, the team harness, your systems),
 * with every block named and one drawer between the harnesses showing what
 * runs inside each of them: the fixed gate every call passes, agents and
 * skills, capabilities and their operations, adapters, and the runtime
 * stores. Credentials run down the sides: personal from the laptop, service
 * from the team harness.
 */
function PlatformArchitectureFigure({ palette }: FigureProps) {
  const tile = (text: string) => (
    <Tile key={text} palette={palette}>
      {text}
    </Tile>
  )
  const then = (
    <span style={{ fontFamily: MONO, fontSize: 13, color: palette.ink40 }}>
      →
    </span>
  )
  const chain = (steps: string[], lead?: boolean) => (
    <Line gap={6}>
      {lead && then}
      {steps.map((step, i) => (
        <span
          key={step}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          {i > 0 && then}
          {tile(step)}
        </span>
      ))}
    </Line>
  )

  const band: CSSProperties = {
    position: 'absolute',
    left: 150,
    width: 1300,
    boxSizing: 'border-box',
    padding: '0 20px',
    background: palette.paperDeepSolid,
    display: 'flex',
    alignItems: 'center',
    gap: 24,
  }
  const lab: CSSProperties = {
    width: 190,
    flex: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  }
  const group: CSSProperties = {
    flex: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  }
  const pane: CSSProperties = {
    top: 310,
    width: 570,
    height: 210,
    boxSizing: 'border-box',
    padding: '0 24px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    gap: 4,
  }
  const rows: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    marginTop: 16,
  }
  const ghost: CSSProperties = {
    width: 570,
    height: 210,
    boxSizing: 'border-box',
    border: `1px dashed ${palette.ink40}`,
  }
  const onPlate = `color-mix(in srgb, ${palette.inverseFg} 25%, transparent)`
  const plateTile = (text: string) => (
    <Tile key={text} palette={palette} border={onPlate} padding="0 10px">
      {text}
    </Tile>
  )
  const paneTile = (text: string) => (
    <Tile key={text} palette={palette} padding="0 10px">
      {text}
    </Tile>
  )

  return (
    <FigureCanvas palette={palette} width={WIDTH} height={HEIGHT}>
      <div style={{ ...band, top: 80, height: 150 }}>
        <div style={lab}>
          <LayerName>Every way in</LayerName>
          <LayerSub colour={palette.ink60}>
            people in their editor, any agent over MCP, the CLI, HTTP, and
            triggers that need nobody
          </LayerSub>
        </div>
        <div style={group}>
          <Label palette={palette}>When someone asks</Label>
          <div
            style={{
              display: 'grid',
              gap: 8,
              gridTemplateColumns: 'auto auto',
            }}
          >
            {ASKED.map((door) => (
              <Tile key={door} palette={palette}>
                <LockMark colour={palette.ink60} />
                {door}
              </Tile>
            ))}
          </div>
        </div>
        <div style={{ ...group, marginLeft: 4 }}>
          <Label palette={palette}>When nobody asks</Label>
          <div
            style={{
              display: 'grid',
              gap: 8,
              gridTemplateColumns: 'auto auto auto',
            }}
          >
            {UNASKED.map(tile)}
          </div>
        </div>
        <div
          style={{
            width: 160,
            height: 76,
            flex: 'none',
            marginLeft: 'auto',
            boxSizing: 'border-box',
            border: `1px solid ${palette.ink25}`,
            background: palette.paper,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            gap: 2,
          }}
        >
          <span
            style={{
              fontFamily: EDITORIAL,
              fontSize: 26,
              lineHeight: 1.1,
              fontWeight: 500,
              fontVariationSettings: '"opsz" 72, "SOFT" 30',
            }}
          >
            you
          </span>
          <span
            style={{
              fontFamily: 'var(--font-sans)',
              fontSize: 12,
              color: palette.ink60,
            }}
          >
            approve by mail or chat
          </span>
        </div>
      </div>

      <Tag palette={palette} style={{ left: 166, top: 256 }}>
        one per person
      </Tag>
      <div style={{ ...at(166, 294), ...ghost }} />
      <div style={{ ...at(158, 302), ...ghost }} />
      <div
        style={{ ...at(150, 310), ...pane, background: palette.paperDeepSolid }}
      >
        <LayerName>Local harness</LayerName>
        <LayerSub colour={palette.ink60}>
          on your laptop, personal credentials
        </LayerSub>
        <div style={rows}>
          <Line>
            {paneTile('team capabilities, over a remote')}
            {paneTile('your own capabilities')}
          </Line>
          <Line>
            {paneTile('an agent in your editor')}
            {paneTile('the terminal UI')}
          </Line>
        </div>
      </div>
      <div style={{ ...at(880, 310), ...pane, background: palette.inverseBg }}>
        <LayerName colour={palette.inverseAccent}>Team harness</LayerName>
        <LayerSub colour={palette.inverseFg}>
          <span style={{ opacity: 0.7 }}>
            always on, service credentials, every call on record
          </span>
        </LayerSub>
        <div style={rows}>
          <Line>
            {plateTile('health and readiness')}
            {plateTile('the ops API')}
            {plateTile('telemetry on record')}
          </Line>
          <Line>
            {plateTile('work that survives restarts')}
            {plateTile('conversations that resume')}
          </Line>
        </div>
      </div>

      <Tag
        palette={palette}
        style={{ left: 808, top: 328, transform: 'translateX(-50%)' }}
      >
        promote when proven
      </Tag>
      <Tag
        palette={palette}
        style={{ left: 808, top: 382, transform: 'translateX(-50%)' }}
      >
        remote
      </Tag>
      <div
        style={{
          ...at(752, 422),
          width: 112,
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
          capabilities,
          <br />
          skills, agents,
          <br />
          as npm packages
        </span>
      </div>
      <Tag
        palette={palette}
        style={{
          left: 1338,
          top: 252,
          transform: 'translateX(-100%)',
          textAlign: 'right',
        }}
      >
        asks you when it
        <br />
        needs a decision
      </Tag>
      <Tag
        palette={palette}
        style={{
          left: 92,
          top: 805,
          writingMode: 'vertical-rl',
          transform: 'translate(-50%, -50%) rotate(180deg)',
        }}
      >
        personal credentials
      </Tag>
      <Tag
        palette={palette}
        accent
        style={{
          left: 1508,
          top: 805,
          writingMode: 'vertical-rl',
          transform: 'translate(-50%, -50%)',
        }}
      >
        service credentials
      </Tag>

      <div
        style={{
          ...at(150, 580),
          width: 1300,
          height: 501,
          boxSizing: 'border-box',
          padding: '18px 20px',
          background: palette.paperDeepSolid,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 18,
            height: 36,
          }}
        >
          <LayerName>Inside every harness</LayerName>
          <LayerSub colour={palette.ink60}>
            the same runtime on a laptop and on a server
          </LayerSub>
        </div>
        <div style={{ display: 'flex', marginTop: 14, flex: 1 }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <DrawerRow
              palette={palette}
              label="The gate, in a fixed order"
              first
            >
              {chain([
                'authenticate',
                'authorise by scope',
                'validate input',
                'throttle',
                'circuit breaker',
              ])}
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 10.5,
                  lineHeight: '14px',
                  margin: '-4px 0 -2px',
                  color: palette.ink55,
                }}
              >
                JWT, JWKS, API keys, OAuth
              </span>
              {chain(['retry', 'timeout', 'concurrency', 'cache'], true)}
            </DrawerRow>
            <DrawerRow palette={palette} label="Agents and skills">
              <Line>
                {[
                  'named agents',
                  'any model',
                  'skills',
                  'tools are capabilities',
                ].map(tile)}
              </Line>
              <Line>
                {['sessions', 'defer and resume', 'asks you for decisions'].map(
                  tile,
                )}
              </Line>
            </DrawerRow>
            <DrawerRow palette={palette} label="Capabilities">
              <Line>
                {tile('craft() defines one')}
                <span
                  style={{
                    width: 1,
                    height: 24,
                    margin: '0 8px',
                    background: palette.ink25,
                  }}
                />
                {['transform', 'enrich', 'filter', 'choice', 'split'].map(tile)}
              </Line>
              <Line indent={199}>
                {['aggregate', 'dedupe', 'multicast', 'dispatch', 'defer'].map(
                  tile,
                )}
              </Line>
            </DrawerRow>
            <DrawerRow palette={palette} label="Adapters">
              <Line>
                {[
                  'HTTP',
                  'mail',
                  'files and folders',
                  'CSV, JSON, XML, HTML',
                  'a sandboxed shell',
                ].map(tile)}
              </Line>
              <Line>
                {[
                  'a browser',
                  'other MCP servers',
                  'contacts',
                  'models and embeddings',
                ].map(tile)}
              </Line>
            </DrawerRow>
          </div>
          <div
            style={{
              width: 156,
              marginLeft: 16,
              paddingLeft: 16,
              borderLeft: `1px solid ${palette.ink15}`,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <Label palette={palette}>Runtime</Label>
            {[
              'event bus',
              'telemetry store',
              'deferral store',
              'session store',
            ].map((store) => (
              <Tile key={store} palette={palette} center>
                {store}
              </Tile>
            ))}
          </div>
        </div>
      </div>

      <div style={{ ...band, top: 1131, height: 130 }}>
        <div style={lab}>
          <LayerName>Your systems</LayerName>
          <LayerSub colour={palette.ink60}>
            as they are, where they are
          </LayerSub>
        </div>
        <div
          style={{
            display: 'grid',
            gap: 8,
            gridTemplateColumns: 'repeat(4, auto)',
          }}
        >
          {SYSTEMS.map((system) => (
            <Tile key={system} palette={palette}>
              <StoreMark colour={palette.ink60} size={13} />
              {system}
            </Tile>
          ))}
        </div>
        <div
          style={{
            ...group,
            marginLeft: 'auto',
            paddingLeft: 24,
            borderLeft: `1px solid ${palette.ink15}`,
          }}
        >
          <Label palette={palette}>Model providers</Label>
          {tile('any provider you approve')}
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
          <ArrowheadMarker
            id="platform-architecture-ink"
            colour={palette.ink60}
          />
          <ArrowheadMarker
            id="platform-architecture-accent"
            colour={palette.accent}
          />
        </defs>
        <g stroke={palette.ink60} markerEnd="url(#platform-architecture-ink)">
          <line x1="435" y1="230" x2="435" y2="308" />
          <line x1="1165" y1="230" x2="1165" y2="308" />
          <line x1="1350" y1="310" x2="1350" y2="232" />
          <line x1="738" y1="352" x2="878" y2="352" />
          <line x1="752" y1="452" x2="738" y2="452" />
          <line x1="864" y1="452" x2="878" y2="452" />
          <line
            x1="878"
            y1="374"
            x2="738"
            y2="374"
            strokeDasharray="2 5"
            strokeLinecap="round"
          />
          <polyline
            points="150,415 110,415 110,1196 148,1196"
            strokeDasharray="6 5"
          />
        </g>
        <g stroke={palette.ink25} strokeWidth="1">
          <line x1="720" y1="520" x2="800" y2="580" />
          <line x1="880" y1="520" x2="800" y2="580" />
        </g>
        <polyline
          points="1450,415 1490,415 1490,1196 1452,1196"
          stroke={palette.accent}
          markerEnd="url(#platform-architecture-accent)"
        />
      </svg>

      <Conclusion
        palette={palette}
        accent="the same capabilities everywhere."
        style={{ position: 'absolute', left: 72, right: 72, bottom: 56 }}
      >
        One runtime, every way in,
      </Conclusion>
    </FigureCanvas>
  )
}

/**
 * Motif: the platform motif with the drawer pulled open, a wider panel
 * between the harnesses and the systems.
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
      {box(72, 8, palette.muted25)}
      <div style={{ display: 'flex', gap: unit * 6 }}>
        {box(33, 16, palette.muted25)}
        {box(33, 16, palette.fg)}
      </div>
      {box(72, 24, palette.muted25)}
      {box(72, 8, palette.muted25)}
    </div>
  )
}

export const platformArchitecture: FigureDrawing = {
  id: 'platform-architecture',
  width: WIDTH,
  height: HEIGHT,
  Figure: PlatformArchitectureFigure,
  Motif,
}
