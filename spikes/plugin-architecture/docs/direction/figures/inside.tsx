import type { CSSProperties, ReactNode } from "react";

import {
  AccentItalic,
  Divider,
  Eyebrow,
  FigureCanvas,
  Subhead,
} from "./primitives.tsx";
import { Terminal } from "./flow.tsx";
import type { FigurePalette } from "./palette.ts";
import type { FigureDrawing, FigureProps, MotifProps } from "./types.ts";

/**
 * The architecture from the inside: the kernel's three columns (host,
 * runtime, continuation), the plugins above reaching it through one strip of
 * sockets, and the ports it calls out through below. Drawn on absolute
 * coordinates so every edge can be routed around the boxes; the edges are one
 * SVG layer, typed by the legend: contract, the exchange's path, or
 * implementation.
 */
const WIDTH = 1600;
const HEIGHT = 1470;

const MONO = "var(--font-mono)";
const SANS = "var(--font-sans)";

type Kind = "contract" | "path" | "implementation";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function Box({
  palette,
  at,
  title,
  body,
  tone = "plain",
  align = "center",
  titleSize = "1.02rem",
}: {
  palette: FigurePalette;
  at: Rect;
  title: ReactNode;
  body?: ReactNode;
  tone?: "plain" | "accent" | "muted";
  align?: "center" | "left";
  titleSize?: string;
}) {
  const accent = tone === "accent";
  return (
    <div
      style={{
        position: "absolute",
        left: at.x,
        top: at.y,
        width: at.w,
        height: at.h,
        border: `${accent ? 2 : 1}px ${tone === "muted" ? "dashed" : "solid"} ${accent ? palette.accent : palette.ink35}`,
        background: palette.paper,
        padding: "8px 14px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: align === "center" ? "center" : "flex-start",
        textAlign: align,
        gap: 3,
      }}
    >
      <span
        style={{
          fontFamily: MONO,
          fontSize: titleSize,
          letterSpacing: "0.03em",
          color: accent
            ? palette.accent
            : tone === "muted"
              ? palette.ink55
              : palette.ink,
          whiteSpace: "nowrap",
        }}
      >
        {title}
      </span>
      {body ? (
        <span
          style={{
            fontFamily: SANS,
            fontSize: "0.84rem",
            lineHeight: 1.3,
            color: palette.ink60,
          }}
        >
          {body}
        </span>
      ) : null}
    </div>
  );
}

function Label({
  palette,
  x,
  y,
  children,
  accent = false,
  width,
  align = "left",
  style,
}: {
  palette: FigurePalette;
  x: number;
  y: number;
  children: ReactNode;
  accent?: boolean;
  width?: number;
  align?: "left" | "center" | "right";
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        position: "absolute",
        left: x,
        top: y,
        width,
        textAlign: align,
        fontFamily: MONO,
        fontSize: "0.8rem",
        lineHeight: 1.3,
        color: accent ? palette.accent : palette.ink55,
        background: palette.paper,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

function Section({
  palette,
  x,
  y,
  children,
  accent = false,
}: {
  palette: FigurePalette;
  x: number;
  y: number;
  children: ReactNode;
  accent?: boolean;
}) {
  return (
    <span
      style={{
        position: "absolute",
        left: x,
        top: y,
        fontFamily: MONO,
        fontSize: "0.82rem",
        letterSpacing: "0.18em",
        textTransform: "uppercase",
        color: accent ? palette.accent : palette.ink55,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

/** One routed edge. `d` is an SVG path in canvas coordinates; the head is drawn at its end. */
function Line({
  palette,
  d,
  kind,
  head = true,
}: {
  palette: FigurePalette;
  d: string;
  kind: Kind;
  head?: boolean;
}) {
  const color = kind === "path" ? palette.accent : palette.ink40;
  return (
    <path
      d={d}
      style={{
        fill: "none",
        stroke: color,
        strokeWidth: kind === "path" ? 1.8 : 1.2,
        strokeDasharray: kind === "implementation" ? "6 5" : undefined,
      }}
      markerEnd={
        head ? `url(#head-${kind === "path" ? "path" : "ink"})` : undefined
      }
    />
  );
}

function LegendItem({
  palette,
  kind,
  children,
}: {
  palette: FigurePalette;
  kind: Kind;
  children: ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <svg width={56} height={12} style={{ overflow: "visible", flex: "none" }}>
        <line
          x1={0}
          y1={6}
          x2={48}
          y2={6}
          style={{
            stroke: kind === "path" ? palette.accent : palette.ink40,
            strokeWidth: kind === "path" ? 1.8 : 1.2,
            strokeDasharray: kind === "implementation" ? "6 5" : undefined,
          }}
        />
        <path
          d="M46,1 L55,6 L46,11 Z"
          style={{ fill: kind === "path" ? palette.accent : palette.ink40 }}
        />
      </svg>
      <span
        style={{
          fontFamily: MONO,
          fontSize: "0.86rem",
          color: kind === "path" ? palette.accent : palette.ink55,
        }}
      >
        {children}
      </span>
    </div>
  );
}

const PLUGINS: {
  id: string;
  does: string;
  theirs?: boolean;
  displaced?: boolean;
}[] = [
  { id: "operations", does: "steps: .transform(), .from()" },
  { id: "resilience", does: "wrappers; owns the RETRY and TIMEOUT anchors" },
  { id: "principals", does: "provides AUTHORITY: the header and the brand" },
  { id: "auth", does: "admission handler: the gate, and the door on a resume" },
  { id: "deferral", does: "provides CONTINUATIONS; .defer(); sweep timer" },
  { id: "sqlite", does: "provides RECORDS; displaced here", displaced: true },
  {
    id: "acme.store",
    does: "provides RECORDS, declared as a replacement",
    theirs: true,
  },
  {
    id: "acme.audit",
    does: "a wrapper after RETRY, before TIMEOUT",
    theirs: true,
  },
];

const SOCKETS: { name: string; note: string }[] = [
  { name: "port", note: "require · provide" },
  { name: "contribution", note: "handler · wrapper" },
  { name: "step", note: "returns an outcome" },
  { name: "facet", note: "ex.<namespace>" },
  { name: "point", note: "a moment handlers join" },
  { name: "execution", note: "deliver · resume · sweep" },
];

function Figure({ palette }: FigureProps) {
  const pluginW = 170;
  const pluginGap = (1440 - 8 * pluginW) / 7;
  const pluginX = (i: number) => 80 + i * (pluginW + pluginGap);
  const socketW = (1440 - 5 * 10) / 6;
  const socketX = (i: number) => 80 + i * (socketW + 10);
  const spine = { x: 440, w: 320 };
  const lane = { x: 790, w: 170 };
  const cont = { x: 1000, w: 500 };
  const host = { x: 104, w: 290 };
  const mid = spine.x + spine.w / 2;
  const executionX = socketX(5) + socketW / 2;

  return (
    <FigureCanvas palette={palette} width={WIDTH} height={HEIGHT}>
      <div
        style={{
          position: "absolute",
          left: 80,
          top: 64,
          right: 160,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <Eyebrow palette={palette} accent>
          Inside
        </Eyebrow>
        <Subhead palette={palette} size="1.95rem">
          The kernel decides when things run and how a parked exchange comes
          back. Everything that runs is a plugin&apos;s.
        </Subhead>
      </div>

      <Section palette={palette} x={80} y={196}>
        First party
      </Section>
      <Section palette={palette} x={pluginX(6)} y={196} accent>
        Third party
      </Section>
      {PLUGINS.map((p, i) => (
        <Box
          key={p.id}
          palette={palette}
          at={{ x: pluginX(i), y: 222, w: pluginW, h: 96 }}
          title={p.id}
          body={p.does}
          tone={p.theirs ? "accent" : p.displaced ? "muted" : "plain"}
        />
      ))}

      {SOCKETS.map((s, i) => (
        <div
          key={s.name}
          style={{
            position: "absolute",
            left: socketX(i),
            top: 370,
            width: socketW,
            height: 50,
            border: `1px solid ${palette.ink}`,
            background: palette.paperDeep,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 2,
          }}
        >
          <span
            style={{
              fontFamily: MONO,
              fontSize: "0.92rem",
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              color: palette.ink,
            }}
          >
            {s.name}
          </span>
          <span
            style={{
              fontFamily: MONO,
              fontSize: "0.76rem",
              color: palette.ink55,
            }}
          >
            {s.note}
          </span>
        </div>
      ))}

      <div
        style={{
          position: "absolute",
          left: 80,
          top: 446,
          width: 1440,
          height: 730,
          border: `2px solid ${palette.ink}`,
        }}
      />
      <span
        style={{
          position: "absolute",
          left: 80,
          top: 446,
          background: palette.inverseBg,
          color: palette.inverseFg,
          fontFamily: MONO,
          fontSize: "0.9rem",
          letterSpacing: "0.22em",
          padding: "7px 16px",
        }}
      >
        KERNEL
      </span>

      <Section palette={palette} x={host.x} y={500}>
        Host · lifecycle
      </Section>
      {[
        ["identity, then resolve ports", "one provider per port, or refuse"],
        ["order plugins", "by what they require and provide"],
        ["bind, then freeze", "no contribution after the last bind"],
        ["order contributions", "by anchor, with the same sort"],
        ["compile routes", "one wrapper chain per route"],
        ["start · stop in reverse", "sources first; disposers always run"],
      ].map(([t, b], i) => (
        <Box
          key={t}
          palette={palette}
          at={{ x: host.x, y: 530 + i * 76, w: host.w, h: 58 }}
          title={t}
          body={b}
          titleSize="0.96rem"
        />
      ))}
      <Label palette={palette} x={host.x} y={1000} width={host.w}>
        an anchor belongs to a port: RETRY and TIMEOUT are the RESILIENCE
        contract&apos;s, so a replacement keeps them
      </Label>

      <Section palette={palette} x={spine.x} y={500}>
        Runtime · one run
      </Section>
      <Box
        palette={palette}
        at={{ x: spine.x, y: 530, w: spine.w, h: 54 }}
        title="a run"
        body="normal · resume · debounce · errorChannel"
      />
      <Box
        palette={palette}
        at={{ x: spine.x, y: 612, w: spine.w, h: 56 }}
        title="admission ring"
        body="decorate or refuse; the door on a resume"
      />
      <Box
        palette={palette}
        at={{ x: spine.x, y: 694, w: spine.w, h: 50 }}
        title="entry ring"
        body="decorate or refuse"
      />
      <div
        style={{
          position: "absolute",
          left: spine.x,
          top: 770,
          width: spine.w,
          height: 100,
          border: `1px solid ${palette.ink35}`,
          background: palette.paper,
          padding: "10px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <span
          style={{
            fontFamily: MONO,
            fontSize: "0.96rem",
            color: palette.ink,
            textAlign: "center",
          }}
        >
          wrappers, by anchor
        </span>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            justifyContent: "center",
          }}
        >
          {["breaker", "retry", "acme.audit", "timeout", "concurrency"].map(
            (w) => (
              <span
                key={w}
                style={{
                  fontFamily: MONO,
                  fontSize: "0.8rem",
                  padding: "3px 8px",
                  border: `1px solid ${w === "acme.audit" ? palette.accent : palette.ink25}`,
                  color: w === "acme.audit" ? palette.accent : palette.ink60,
                }}
              >
                {w}
              </span>
            ),
          )}
        </div>
      </div>
      <Box
        palette={palette}
        at={{ x: spine.x, y: 896, w: spine.w, h: 70 }}
        tone="accent"
        title="step loop"
        body="continue · complete · drop · branch · fanOut · defer"
      />
      <Box
        palette={palette}
        at={{ x: spine.x, y: 992, w: spine.w, h: 50 }}
        title="exit ring"
        body="over completed exchanges only"
      />
      <Terminal
        palette={palette}
        tone="inverse"
        style={{
          position: "absolute",
          left: spine.x + 40,
          top: 1072,
          width: spine.w - 80,
        }}
      >
        completed
      </Terminal>

      <Terminal
        palette={palette}
        style={{
          position: "absolute",
          left: lane.x,
          top: 616,
          width: lane.w,
          fontSize: "0.92rem",
          padding: "12px 10px",
        }}
      >
        refused
      </Terminal>
      <Label palette={palette} x={lane.x} y={666} width={lane.w} align="center">
        at admission, the error ring is told
      </Label>
      <Box
        palette={palette}
        at={{ x: lane.x, y: 776, w: lane.w, h: 88 }}
        title="error ring"
        body="hears what escapes the wrappers; may park"
        titleSize="0.96rem"
      />
      <Terminal
        palette={palette}
        style={{
          position: "absolute",
          left: lane.x,
          top: 900,
          width: lane.w,
          fontSize: "0.92rem",
          padding: "12px 10px",
        }}
      >
        failed
      </Terminal>

      <Section palette={palette} x={cont.x} y={500}>
        Continuation · the protocol
      </Section>
      <Box
        palette={palette}
        at={{ x: cont.x, y: 530, w: cont.w, h: 54 }}
        title="resume(id, ingress)"
        body="an approval, from anything that holds execution"
      />
      <Box
        palette={palette}
        at={{ x: cont.x, y: 610, w: cont.w, h: 64 }}
        tone="accent"
        title="the door"
        body="admission over the ingress: a refusal discloses and spends nothing"
      />
      <Box
        palette={palette}
        at={{ x: cont.x, y: 700, w: cont.w, h: 58 }}
        title="deadline, then the live tail"
        body="expired or edited: settled through a claim, the route told"
      />
      <Box
        palette={palette}
        at={{ x: cont.x, y: 784, w: cont.w, h: 58 }}
        title="markResumed"
        body="compare-and-swap: one caller wins, a second is answered from the record"
      />
      <Box
        palette={palette}
        at={{ x: cont.x, y: 870, w: cont.w, h: 58 }}
        title="sweep()"
        body="claim → error channel → expired; the deferral timer calls it"
      />
      <Box
        palette={palette}
        at={{ x: cont.x, y: 966, w: cont.w, h: 70 }}
        tone="accent"
        title="park"
        body="site, frames, tail hash, codec; declined where reviving would be wrong"
      />
      <Box
        palette={palette}
        at={{ x: cont.x, y: 1066, w: 300, h: 70 }}
        title="create · notify(id)"
        body="durable before anyone is told"
      />
      <Terminal
        palette={palette}
        tone="inverse"
        style={{
          position: "absolute",
          left: cont.x + 330,
          top: 1080,
          width: cont.w - 330,
          fontSize: "0.92rem",
          padding: "12px 10px",
        }}
      >
        deferred
      </Terminal>

      <Box
        palette={palette}
        at={{ x: cont.x, y: 1228, w: 220, h: 64 }}
        title="CONTINUATIONS"
        body="the deferral plugin's store"
      />
      <Box
        palette={palette}
        at={{ x: cont.x + 280, y: 1228, w: 220, h: 64 }}
        tone="accent"
        title="RECORDS"
        body="acme.store, not sqlite"
      />

      <div
        style={{
          position: "absolute",
          left: 80,
          top: 1214,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <LegendItem palette={palette} kind="contract">
          contract: a socket or a port, published and versioned
        </LegendItem>
        <LegendItem palette={palette} kind="path">
          the exchange&apos;s path through one run
        </LegendItem>
        <LegendItem palette={palette} kind="implementation">
          implementation: inside the kernel, free to change
        </LegendItem>
      </div>

      <svg
        width={WIDTH}
        height={HEIGHT}
        style={{
          position: "absolute",
          inset: 0,
          overflow: "visible",
          pointerEvents: "none",
        }}
      >
        <defs>
          <marker
            id="head-ink"
            viewBox="0 0 10 10"
            refX={9}
            refY={5}
            markerWidth={8}
            markerHeight={8}
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 Z" style={{ fill: palette.ink40 }} />
          </marker>
          <marker
            id="head-path"
            viewBox="0 0 10 10"
            refX={9}
            refY={5}
            markerWidth={8}
            markerHeight={8}
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 Z" style={{ fill: palette.accent }} />
          </marker>
        </defs>

        {PLUGINS.map((p, i) => (
          <Line
            key={p.id}
            palette={palette}
            kind="contract"
            d={`M${pluginX(i) + pluginW / 2},318 V368`}
          />
        ))}
        {SOCKETS.slice(0, 5).map((s, i) => (
          <Line
            key={s.name}
            palette={palette}
            kind="contract"
            d={`M${socketX(i) + socketW / 2},420 V444`}
          />
        ))}

        <Line
          palette={palette}
          kind="contract"
          d={`M${executionX},420 V478 H${spine.x + spine.w - 40} V528`}
        />
        <Line palette={palette} kind="contract" d={`M${executionX},478 V528`} />

        {[0, 1, 2, 3, 4].map((i) => (
          <Line
            key={i}
            palette={palette}
            kind="implementation"
            d={`M${host.x + host.w / 2},${588 + i * 76} V${528 + (i + 1) * 76}`}
          />
        ))}
        <Line
          palette={palette}
          kind="implementation"
          d={`M${host.x + host.w},${834 + 29} H${spine.x - 2}`}
        />

        <Line palette={palette} kind="path" d={`M${mid},584 V610`} />
        <Line palette={palette} kind="path" d={`M${mid},668 V692`} />
        <Line palette={palette} kind="path" d={`M${mid},744 V768`} />
        <Line palette={palette} kind="path" d={`M${mid},870 V894`} />
        <Line palette={palette} kind="path" d={`M${mid},966 V990`} />
        <Line palette={palette} kind="path" d={`M${mid},1042 V1070`} />
        <Line
          palette={palette}
          kind="path"
          d={`M${spine.x + spine.w},640 H${lane.x - 2}`}
        />
        <Line
          palette={palette}
          kind="path"
          d={`M${spine.x + spine.w},${820} H${lane.x - 2}`}
        />
        <Line
          palette={palette}
          kind="path"
          d={`M${lane.x + lane.w / 2},864 V898`}
        />
        <Line
          palette={palette}
          kind="path"
          d={`M${lane.x + lane.w},850 H988 V1001 H${cont.x - 2}`}
        />
        <Line
          palette={palette}
          kind="path"
          d={`M${spine.x + spine.w},${931} H778 V1001 H988`}
          head={false}
        />

        <Line
          palette={palette}
          kind="path"
          d={`M${cont.x + cont.w / 2},584 V608`}
        />
        <Line
          palette={palette}
          kind="path"
          d={`M${cont.x + cont.w / 2},674 V698`}
        />
        <Line
          palette={palette}
          kind="path"
          d={`M${cont.x + cont.w / 2},758 V782`}
        />
        <Line
          palette={palette}
          kind="path"
          d={`M${cont.x},806 H972 V719 H${spine.x + spine.w + 2}`}
        />
        <Line
          palette={palette}
          kind="implementation"
          d={`M${cont.x + 150},1036 V1064`}
        />
        <Line
          palette={palette}
          kind="implementation"
          d={`M${cont.x + 300},1101 H${cont.x + 328}`}
        />

        <Line
          palette={palette}
          kind="contract"
          d={`M${cont.x + 110},1136 V1226`}
        />
        <Line
          palette={palette}
          kind="contract"
          d={`M${cont.x + 220},1260 H${cont.x + 278}`}
        />
      </svg>

      <Label palette={palette} x={mid + 180} y={454} accent={false}>
        deliver · errorChannel
      </Label>
      <Label
        palette={palette}
        x={executionX - 150}
        y={454}
        width={140}
        align="right"
      >
        resume · sweep
      </Label>
      <Label palette={palette} x={lane.x + 2} y={732} width={188} accent>
        re-enter at entry
      </Label>
      <Label palette={palette} x={lane.x + 2} y={1010} width={188} accent>
        defer, or a park
      </Label>
      <Label palette={palette} x={cont.x + 122} y={1188} width={370}>
        every transition, through the port
      </Label>

      <div style={{ position: "absolute", left: 80, right: 80, top: 1350 }}>
        <Divider palette={palette} />
      </div>
      <div
        style={{
          position: "absolute",
          left: 80,
          right: 80,
          top: 1378,
          textAlign: "center",
          fontFamily: "var(--font-editorial)",
          fontStyle: "italic",
          fontSize: "2rem",
          color: palette.ink60,
          fontVariationSettings: '"opsz" 144, "SOFT" 100',
        }}
      >
        One order of rings for every run,{" "}
        <AccentItalic palette={palette} size="2rem">
          and one strip of sockets for every plugin.
        </AccentItalic>
      </div>
    </FigureCanvas>
  );
}

function Motif({ palette, size }: MotifProps) {
  const u = size / 100;
  return (
    <div
      style={{
        width: size,
        height: size,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: u * 5,
      }}
    >
      <div style={{ display: "flex", gap: u * 4 }}>
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            style={{
              width: u * 12,
              height: u * 9,
              border: `${Math.max(2, u * 1.4)}px solid ${i === 3 ? palette.accent : palette.muted55}`,
            }}
          />
        ))}
      </div>
      <div
        style={{
          width: u * 64,
          height: u * 44,
          border: `${Math.max(2, u * 1.6)}px solid ${palette.fg}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: u * 5,
        }}
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            style={{
              width: u * 3,
              height: u * 30,
              backgroundColor: i === 1 ? palette.accent : palette.muted40,
            }}
          />
        ))}
      </div>
    </div>
  );
}

export const inside: FigureDrawing = {
  id: "inside",
  width: WIDTH,
  height: HEIGHT,
  Figure,
  Motif,
};
