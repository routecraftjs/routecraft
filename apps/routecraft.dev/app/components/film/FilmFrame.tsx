import type { CSSProperties, ReactNode } from 'react'

import {
  ACCESS_LINE,
  BOARD,
  BOARD_EXIT,
  type BoardCard,
  CALLS,
  CAPABILITY,
  CAPABILITY_AT,
  CAPTIONS,
  CARD_H,
  CREDENTIALS,
  CROSSING,
  clamp01,
  DOOR_AT,
  DOORS,
  DUPLICATE_PULSE,
  END_CARD,
  FILM_HEIGHT,
  FILM_WIDTH,
  LOCAL_PANEL,
  LOCAL_PANEL_IN,
  mix,
  mixRect,
  PROMOTE,
  RECORD_LINES,
  type Rect,
  ramp,
  ROUTE_LINE,
  SCENE_OUT,
  SECOND_LOCAL,
  SETTLE,
  SYSTEM_TILE_H,
  SYSTEM_TILE_X,
  SYSTEM_TILE_Y,
  SYSTEMS,
  SYSTEMS_BAND,
  span,
  systemCentre,
  TEAM_BLOCK_AT,
  TEAM_BLOCKS,
  TEAM_IN,
  TEAM_PANEL,
  TELEMETRY,
  TEST_LINE,
  TOP_BAND,
  TOP_BAND_IN,
  TRIGGER_AT,
  TRIGGERS,
  blockRect,
} from './timeline'

/**
 * One frame of the platform film, as a pure function of time: the same `t`
 * always draws the same picture, which is what lets the player run it live and
 * the render script record it frame by frame.
 *
 * Every colour and face comes from the site's tokens through CSS variables, so
 * the film re-tones with the theme; the fallbacks are the light values, for
 * the render harness. Styles are inline because every value moves.
 */
export function FilmFrame({ t }: { t: number }) {
  const scene = 1 - ramp(t, SCENE_OUT.from, SCENE_OUT.duration)
  return (
    <div
      style={{
        position: 'relative',
        width: FILM_WIDTH,
        height: FILM_HEIGHT,
        overflow: 'hidden',
        background: PAPER,
        color: INK_SOLID,
        fontFamily: SANS,
      }}
    >
      <div style={{ position: 'absolute', inset: 0, opacity: scene }}>
        <SystemsBand t={t} />
        <BoardWires t={t} />
        {BOARD.map((card, i) => (
          <BoardTile key={i} card={card} t={t} i={i} />
        ))}
        <TopBand t={t} />
        <SecondLocal t={t} />
        <LocalPanel t={t} />
        <TeamPanel t={t} />
        <LocalCapability t={t} />
        <Crossing t={t} />
        <Arrows t={t} />
      </div>
      <Captions t={t} />
      <EndCard t={t} />
    </div>
  )
}

const PAPER = 'var(--color-paper, #f5f1e8)'
const PAPER_DEEP = 'var(--color-paper-deep, #ebe5da)'
const INK_SOLID = 'var(--color-ink, #22232c)'
const COBALT = 'var(--color-cobalt-500, #1247ff)'
const EDITORIAL = 'var(--font-fraunces, Georgia, serif)'
const SANS = 'var(--font-ibm-plex-sans, system-ui, sans-serif)'
const MONO = 'var(--font-jetbrains-mono, ui-monospace, monospace)'
const ink = (percent: number) =>
  `color-mix(in srgb, ${INK_SOLID} ${percent}%, transparent)`
const paper = (percent: number) =>
  `color-mix(in srgb, ${PAPER} ${percent}%, transparent)`
const DISPLAY = '"opsz" 144, "SOFT" 30'
const DISPLAY_ITALIC = '"opsz" 144, "SOFT" 100'

const at = (r: Rect): CSSProperties => ({
  position: 'absolute',
  left: r.x,
  top: r.y,
  width: r.w,
  height: r.h,
})

/** Labels on blocks and wires fade once the drawing settles. */
const labels = (t: number) => 1 - ramp(t, SETTLE.from, SETTLE.duration)

function Accent({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        color: COBALT,
        fontStyle: 'italic',
        fontVariationSettings: DISPLAY_ITALIC,
      }}
    >
      {children}
    </span>
  )
}

function Captions({ t }: { t: number }) {
  return CAPTIONS.map((caption, ci) => {
    const shown = span(t, caption.from, caption.to, 0.5)
    if (shown <= 0) return null
    const box: CSSProperties = caption.centred
      ? {
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 200px',
          fontSize: 96,
          lineHeight: 1.04,
          textAlign: 'center',
        }
      : {
          position: 'absolute',
          left: 120,
          top: 72,
          width: 1560,
          fontSize: 58,
          lineHeight: 1.12,
        }
    return (
      <p
        key={ci}
        style={{
          ...box,
          margin: 0,
          opacity: shown,
          fontFamily: EDITORIAL,
          fontVariationSettings: DISPLAY,
          letterSpacing: '-0.02em',
        }}
      >
        <span>
          {caption.parts.map((part, pi) => {
            const p = ramp(t, part.at, 0.55)
            return (
              <span
                key={pi}
                style={{
                  opacity: p,
                  display: 'inline',
                  position: 'relative',
                  top: (1 - p) * 10,
                }}
              >
                {part.text}
                {part.accent && <Accent>{part.accent}</Accent>}
                {part.after}
              </span>
            )
          })}
        </span>
      </p>
    )
  })
}

function SystemsBand({ t }: { t: number }) {
  const shown = ramp(t, BOARD[0].at - 0.9, 0.9)
  if (shown <= 0) return null
  return (
    <div
      style={{ ...at(SYSTEMS_BAND), background: PAPER_DEEP, opacity: shown }}
    >
      <PanelTitle
        name="Your systems"
        sub="as they are, where they are"
        x={30}
        y={26}
      />
      {SYSTEMS.map((system, i) => (
        <span
          key={system.label}
          style={{
            ...at({
              x: SYSTEM_TILE_X[i] - SYSTEMS_BAND.x,
              y: SYSTEM_TILE_Y - SYSTEMS_BAND.y,
              w: system.w,
              h: SYSTEM_TILE_H,
            }),
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            border: `1px solid ${ink(22)}`,
            background: PAPER,
            fontFamily: MONO,
            fontSize: 16,
            whiteSpace: 'nowrap',
          }}
        >
          <Cylinder />
          {system.label}
        </span>
      ))}
    </div>
  )
}

function Cylinder() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={15}
      height={15}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      style={{ opacity: 0.55 }}
    >
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </svg>
  )
}

function PanelTitle({
  name,
  sub,
  x,
  y,
  onPlate = false,
}: {
  name: string
  sub: string
  x: number
  y: number
  onPlate?: boolean
}) {
  return (
    <div style={{ position: 'absolute', left: x, top: y }}>
      <div
        style={{
          fontFamily: EDITORIAL,
          fontVariationSettings: DISPLAY,
          fontSize: 36,
          lineHeight: 1,
          letterSpacing: '-0.015em',
          color: onPlate ? PAPER : INK_SOLID,
        }}
      >
        {name}
      </div>
      <div
        style={{
          marginTop: 10,
          fontSize: 17,
          color: onPlate ? paper(70) : ink(65),
        }}
      >
        {sub}
      </div>
    </div>
  )
}

/** How far a board card has left the stage. */
const boardExit = (t: number, i: number) =>
  ramp(t, BOARD_EXIT.from + (i % 5) * 0.08, BOARD_EXIT.duration)

/** The duplicates light up together while the line says the next team builds it again. */
const duplicatePulse = (t: number, card: BoardCard) =>
  card.duplicate
    ? span(
        t,
        DUPLICATE_PULSE.from,
        DUPLICATE_PULSE.from + DUPLICATE_PULSE.duration,
        0.5,
      )
    : 0

function BoardWires({ t }: { t: number }) {
  if (t < BOARD[0].at || t > BOARD_EXIT.from + BOARD_EXIT.duration + 0.5)
    return null
  return (
    <svg
      width={FILM_WIDTH}
      height={FILM_HEIGHT}
      style={{ position: 'absolute', inset: 0 }}
      fill="none"
    >
      {BOARD.map((card, i) => {
        if (!card.to) return null
        const drawn = ramp(t, card.at + 0.25, 0.9)
        if (drawn <= 0) return null
        const sx = card.x + card.w / 2
        const sy = card.y + CARD_H
        const ex = systemCentre(card.to)
        const ey = SYSTEM_TILE_Y
        return (
          <path
            key={i}
            d={`M${sx} ${sy} C${sx} ${sy + 90} ${ex} ${ey - 110} ${ex} ${ey}`}
            pathLength={1}
            stroke={ink(32)}
            strokeWidth={1.5}
            strokeDasharray="1 1"
            strokeDashoffset={1 - drawn}
            opacity={1 - boardExit(t, i)}
          />
        )
      })}
    </svg>
  )
}

function CardFace({ card }: { card: BoardCard }) {
  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          fontFamily: MONO,
          fontSize: 17,
          whiteSpace: 'nowrap',
        }}
      >
        <span
          style={{
            fontSize: 11,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            border: `1px solid ${ink(30)}`,
            padding: '2px 6px',
            color: ink(70),
          }}
        >
          {card.kind}
        </span>
        {card.name}
      </div>
      <div style={{ marginTop: 12, fontSize: 17, color: ink(75) }}>
        {card.line}
      </div>
      <div
        style={{
          marginTop: 6,
          fontFamily: EDITORIAL,
          fontStyle: 'italic',
          fontVariationSettings: DISPLAY_ITALIC,
          fontSize: 18,
          color: ink(55),
        }}
      >
        {card.note}
      </div>
    </>
  )
}

const cardBox: CSSProperties = {
  background: PAPER,
  border: `1px solid ${ink(20)}`,
  boxShadow: 'none',
  padding: '16px 18px',
  boxSizing: 'border-box',
  overflow: 'hidden',
}

function BoardTile({ card, t, i }: { card: BoardCard; t: number; i: number }) {
  const shown = ramp(t, card.at, 0.45)
  const gone = boardExit(t, i)
  const opacity = shown * (1 - gone)
  if (opacity <= 0) return null
  const pulse = duplicatePulse(t, card)
  return (
    <div
      style={{
        ...at({ x: card.x, y: card.y, w: card.w, h: CARD_H }),
        ...cardBox,
        border: `1px solid color-mix(in srgb, ${COBALT} ${Math.round(pulse * 100)}%, ${ink(20)})`,
        opacity,
        transform: `translateY(${(1 - shown) * 16 - gone * 24}px) rotate(${card.tilt}deg) scale(${0.96 + 0.04 * shown + 0.03 * pulse})`,
      }}
    >
      <CardFace card={card} />
    </div>
  )
}

function BlockLabel({
  eyebrow,
  name,
  opacity,
  onPlate = false,
  accent = false,
}: {
  eyebrow: string
  name: string
  opacity: number
  onPlate?: boolean
  accent?: boolean
}) {
  return (
    <div
      style={{ position: 'absolute', inset: 0, padding: '12px 10px', opacity }}
    >
      <div
        style={{
          fontFamily: MONO,
          fontSize: 11,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: accent ? COBALT : onPlate ? paper(60) : ink(55),
        }}
      >
        {eyebrow}
      </div>
      <div
        style={{
          marginTop: 8,
          fontFamily: MONO,
          fontSize: 15,
          whiteSpace: 'nowrap',
          color: onPlate ? PAPER : INK_SOLID,
        }}
      >
        {name}
      </div>
    </div>
  )
}

/** A line of monospaced text typed out from `from`. */
function Typed({
  t,
  text,
  from,
  x,
  y,
  colour,
}: {
  t: number
  text: string
  from: number
  x: number
  y: number
  colour: string
}) {
  const typed = clamp01((t - from) / 0.6)
  if (typed <= 0) return null
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        fontFamily: MONO,
        fontSize: 15,
        whiteSpace: 'pre',
        color: colour,
        opacity: labels(t),
      }}
    >
      {text.slice(0, Math.round(text.length * typed))}
    </div>
  )
}

/** The capability the film follows, built and tested in the local harness. */
function LocalCapability({ t }: { t: number }) {
  const shown = ramp(t, CAPABILITY_AT, 0.6)
  if (shown <= 0) return null
  const settled = ramp(t, CROSSING.from, 1.2)
  return (
    <div
      style={{
        ...at(blockRect(LOCAL_PANEL, 0)),
        boxSizing: 'border-box',
        background: PAPER,
        border: `1.5px solid color-mix(in srgb, ${COBALT} ${Math.round((1 - settled) * 100)}%, ${ink(26)})`,
        opacity: shown,
        transform: `translateY(${(1 - shown) * 18}px) scale(${0.94 + 0.06 * shown})`,
      }}
    >
      <BlockLabel
        eyebrow="capability"
        name={CAPABILITY}
        opacity={labels(t)}
        accent={settled < 1}
      />
    </div>
  )
}

/** The local harness: where a capability is built and proved before anyone else relies on it. */
function LocalPanel({ t }: { t: number }) {
  const shown = ramp(t, LOCAL_PANEL_IN.from, LOCAL_PANEL_IN.duration)
  if (shown <= 0) return null
  return (
    <div style={{ ...at(LOCAL_PANEL), background: PAPER_DEEP, opacity: shown }}>
      <PanelTitle
        name="Local harness"
        sub="on your own machine, on your own access"
        x={30}
        y={28}
      />
      <Typed
        t={t}
        text={ROUTE_LINE.text}
        from={ROUTE_LINE.at}
        x={30}
        y={120}
        colour={ink(72)}
      />
      <Typed
        t={t}
        text={TEST_LINE.text}
        from={TEST_LINE.at}
        x={30}
        y={150}
        colour={COBALT}
      />
    </div>
  )
}

function SecondLocal({ t }: { t: number }) {
  const shown = ramp(t, SECOND_LOCAL.from, SECOND_LOCAL.duration)
  if (shown <= 0) return null
  const r = LOCAL_PANEL
  return (
    <>
      <div
        style={{
          ...at({ x: r.x - 16, y: r.y - 16, w: r.w, h: r.h }),
          border: `1.5px dashed ${ink(35)}`,
          opacity: shown,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: r.x - 16,
          top: r.y - 44,
          fontFamily: MONO,
          fontSize: 13,
          color: ink(60),
          opacity: shown * labels(t),
        }}
      >
        the next team
      </div>
    </>
  )
}

/** How strongly the promoted capability lights up while a caller reaches it. */
const called = (t: number) =>
  Math.max(
    0,
    ...CALLS.map((call) => span(t, call.at + 0.5, call.at + 1.9, 0.4)),
  )

function TeamPanel({ t }: { t: number }) {
  const shown = ramp(t, TEAM_IN.from, TEAM_IN.duration)
  if (shown <= 0) return null
  const arrived = ramp(t, CROSSING.from + CROSSING.duration - 0.1, 0.3)
  const telemetry = ramp(t, TELEMETRY.from, TELEMETRY.duration)
  const pulse = called(t)
  const fresh = 1 - ramp(t, CROSSING.from + CROSSING.duration + 0.8, 1.2)
  const promoted = blockRect(TEAM_PANEL, 0)
  return (
    <div
      style={{
        ...at(TEAM_PANEL),
        background: INK_SOLID,
        opacity: shown,
        transform: `translateX(${(1 - shown) * 40}px)`,
      }}
    >
      <PanelTitle
        name="Team harness"
        sub="on your infrastructure, on service credentials"
        x={30}
        y={28}
        onPlate
      />
      {telemetry > 0 && (
        <div
          style={{
            position: 'absolute',
            right: 30,
            top: 34,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontFamily: MONO,
            fontSize: 14,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: paper(78),
            opacity: telemetry * labels(t),
          }}
        >
          <span
            style={{
              width: 9,
              height: 9,
              borderRadius: 9,
              background: COBALT,
            }}
          />
          telemetry on
        </div>
      )}
      <Typed
        t={t}
        text={ACCESS_LINE.text}
        from={ACCESS_LINE.at}
        x={30}
        y={112}
        colour={paper(78)}
      />
      {RECORD_LINES.map((line, i) => (
        <Typed
          key={line.text}
          t={t}
          text={line.text}
          from={line.at}
          x={30}
          y={146 + i * 24}
          colour={paper(62)}
        />
      ))}
      {arrived > 0 && (
        <div
          style={{
            ...at({
              x: promoted.x - TEAM_PANEL.x,
              y: promoted.y - TEAM_PANEL.y,
              w: promoted.w,
              h: promoted.h,
            }),
            boxSizing: 'border-box',
            background: `color-mix(in srgb, ${COBALT} ${Math.round(pulse * 45)}%, ${paper(12)})`,
            border: `1.5px solid color-mix(in srgb, ${COBALT} ${Math.round(Math.max(pulse, fresh) * 100)}%, ${paper(28)})`,
            opacity: arrived,
            transform: `scale(${1 + 0.05 * pulse})`,
          }}
        >
          <BlockLabel
            eyebrow="capability"
            name={CAPABILITY}
            opacity={labels(t)}
            onPlate
          />
        </div>
      )}
      {TEAM_BLOCKS.map((name, i) => {
        const block = ramp(t, TEAM_BLOCK_AT[i], 0.45)
        if (block <= 0) return null
        const r = blockRect(TEAM_PANEL, i + 1)
        return (
          <div
            key={name}
            style={{
              ...at({
                x: r.x - TEAM_PANEL.x,
                y: r.y - TEAM_PANEL.y,
                w: r.w,
                h: r.h,
              }),
              boxSizing: 'border-box',
              background: paper(12),
              border: `1px solid ${paper(28)}`,
              opacity: block,
            }}
          >
            <BlockLabel
              eyebrow="capability"
              name={name}
              opacity={labels(t)}
              onPlate
            />
          </div>
        )
      })}
    </div>
  )
}

/** The promoted capability travelling from the local harness to the team harness. */
function Crossing({ t }: { t: number }) {
  const p = ramp(t, CROSSING.from, CROSSING.duration)
  if (p <= 0 || t > CROSSING.from + CROSSING.duration + 0.3) return null
  const rect = mixRect(blockRect(LOCAL_PANEL, 0), blockRect(TEAM_PANEL, 0), p)
  const lift = Math.sin(p * Math.PI) * 60
  return (
    <div
      style={{
        ...at({ ...rect, y: rect.y - lift }),
        boxSizing: 'border-box',
        background: PAPER,
        border: `1.5px solid ${COBALT}`,
        opacity: 1 - ramp(t, CROSSING.from + CROSSING.duration, 0.3),
      }}
    >
      <BlockLabel eyebrow="capability" name={CAPABILITY} opacity={1} accent />
    </div>
  )
}

/** Where each door or trigger sits in the top band, in canvas pixels. */
const doorX = (name: string) => {
  const d = DOORS.indexOf(name as (typeof DOORS)[number])
  return d >= 0
    ? 640 + d * 124
    : 1162 + TRIGGERS.indexOf(name as (typeof TRIGGERS)[number]) * 124
}

function TopBand({ t }: { t: number }) {
  const shown = ramp(t, TOP_BAND_IN.from, TOP_BAND_IN.duration)
  if (shown <= 0) return null
  const blocks = [
    ...DOORS.map((name, i) => ({ name, at: DOOR_AT(i), door: true })),
    ...TRIGGERS.map((name, i) => ({ name, at: TRIGGER_AT(i), door: false })),
  ]
  return (
    <div style={{ ...at(TOP_BAND), background: PAPER_DEEP, opacity: shown }}>
      <PanelTitle
        name="Every way in"
        sub="when someone asks, and when nobody does"
        x={30}
        y={22}
      />
      {blocks.map((b) => {
        const p = ramp(t, b.at, 0.4)
        if (p <= 0) return null
        const call = CALLS.find((c) => c.door === b.name)
        const lit = call ? ramp(t, call.at, 0.4) * labels(t) : 0
        return (
          <span
            key={b.name}
            style={{
              ...at({ x: doorX(b.name) - TOP_BAND.x, y: 27, w: 110, h: 56 }),
              boxSizing: 'border-box',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: PAPER,
              border: `1.5px ${b.door ? 'solid' : 'dashed'} color-mix(in srgb, ${COBALT} ${Math.round(lit * 100)}%, ${ink(b.door ? 30 : 38)})`,
              color: `color-mix(in srgb, ${COBALT} ${Math.round(lit * 100)}%, ${INK_SOLID})`,
              fontFamily: MONO,
              fontSize: 16,
              opacity: p,
              transform: `translateY(${(1 - p) * -10}px)`,
            }}
          >
            <span style={{ opacity: labels(t) }}>{b.name}</span>
          </span>
        )
      })}
    </div>
  )
}

function Arrow({
  x1,
  y1,
  x2,
  y2,
  drawn,
  colour,
  dashed = false,
}: {
  x1: number
  y1: number
  x2: number
  y2: number
  drawn: number
  colour: string
  dashed?: boolean
}) {
  if (drawn <= 0) return null
  const x = mix(x1, x2, drawn)
  const y = mix(y1, y2, drawn)
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const head = (a: number) =>
    `${x - 11 * Math.cos(angle + a)},${y - 11 * Math.sin(angle + a)}`
  return (
    <g stroke={colour} strokeWidth={1.6} fill="none">
      <line
        x1={x1}
        y1={y1}
        x2={x}
        y2={y}
        strokeDasharray={dashed ? '6 6' : undefined}
      />
      <polyline points={`${head(0.5)} ${x},${y} ${head(-0.5)}`} />
    </g>
  )
}

function ArrowLabel({
  x,
  y,
  children,
  opacity,
  colour,
  centred = false,
}: {
  x: number
  y: number
  children: ReactNode
  opacity: number
  colour?: string
  /** Centred on `x` instead of starting there. */
  centred?: boolean
}) {
  if (opacity <= 0) return null
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        fontFamily: MONO,
        fontSize: 14,
        whiteSpace: 'nowrap',
        color: colour ?? ink(62),
        opacity,
        transform: centred ? 'translateX(-50%)' : undefined,
      }}
    >
      {children}
    </div>
  )
}

function Arrows({ t }: { t: number }) {
  const promote = ramp(t, PROMOTE.from, PROMOTE.duration)
  const credentials = ramp(t, CREDENTIALS.from, CREDENTIALS.duration)
  const l = labels(t)
  const localX = LOCAL_PANEL.x + 390
  const teamX = TEAM_PANEL.x + 390
  const bottom = LOCAL_PANEL.y + LOCAL_PANEL.h
  const target = blockRect(TEAM_PANEL, 0)
  const targetX = target.x + target.w / 2
  return (
    <>
      <svg
        width={FILM_WIDTH}
        height={FILM_HEIGHT}
        style={{ position: 'absolute', inset: 0 }}
      >
        <Arrow
          x1={904}
          y1={540}
          x2={1014}
          y2={540}
          drawn={promote}
          colour={ink(70)}
        />
        <Arrow
          x1={localX}
          y1={bottom + 4}
          x2={localX}
          y2={SYSTEMS_BAND.y - 6}
          drawn={credentials}
          colour={ink(55)}
          dashed
        />
        <Arrow
          x1={teamX}
          y1={bottom + 4}
          x2={teamX}
          y2={SYSTEMS_BAND.y - 6}
          drawn={credentials}
          colour={COBALT}
        />
        <Arrow
          x1={targetX}
          y1={TOP_BAND.y + TOP_BAND.h + 4}
          x2={targetX}
          y2={TEAM_PANEL.y - 6}
          drawn={ramp(t, CALLS[0].at, 0.5)}
          colour={`color-mix(in srgb, ${COBALT} ${Math.round(called(t) * 100)}%, ${ink(55)})`}
        />
      </svg>
      <ArrowLabel x={906} y={508} opacity={promote * l}>
        promote
      </ArrowLabel>
      {CALLS.map((call) => (
        <ArrowLabel
          key={call.caller}
          x={doorX(call.door) + 55}
          y={TOP_BAND.y + 88}
          opacity={ramp(t, call.at, 0.4) * l}
          colour={COBALT}
          centred
        >
          {call.caller}
        </ArrowLabel>
      ))}
      <ArrowLabel x={localX + 14} y={bottom + 34} opacity={credentials * l}>
        personal credentials
      </ArrowLabel>
      <ArrowLabel
        x={teamX + 14}
        y={bottom + 34}
        opacity={credentials * l}
        colour={COBALT}
      >
        service credentials
      </ArrowLabel>
    </>
  )
}

function EndCard({ t }: { t: number }) {
  const shown = ramp(t, END_CARD.from, 1)
  if (shown <= 0) return null
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: shown,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 34 }}>
        <svg
          viewBox="0 0 200 200"
          width={132}
          height={132}
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M125 175H75V125L125 175ZM175 175H125V125L175 175ZM125 25C152.614 25 175 47.3858 175 75C175 102.614 152.614 125 125 125V75H75L125 125H75L25 75V25H125Z" />
        </svg>
        <span
          style={{
            fontFamily: EDITORIAL,
            fontVariationSettings: DISPLAY,
            fontSize: 132,
            letterSpacing: '-0.03em',
            lineHeight: 1,
          }}
        >
          Routecraft
        </span>
      </div>
      <p
        style={{
          margin: '46px 0 0',
          fontFamily: EDITORIAL,
          fontVariationSettings: DISPLAY,
          fontSize: 54,
          letterSpacing: '-0.02em',
          opacity: ramp(t, END_CARD.from + 0.6, 0.8),
        }}
      >
        Built to be <Accent>used</Accent>.
      </p>
      <p
        style={{
          margin: '40px 0 0',
          fontFamily: MONO,
          fontSize: 20,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: ink(60),
          opacity: ramp(t, END_CARD.from + 1.2, 0.8),
        }}
      >
        open source AI automation platform · routecraft.dev
      </p>
    </div>
  )
}
