import type { CSSProperties, ReactNode } from "react";
import { Fragment } from "react";

import type { FigurePalette } from "./palette.ts";

/**
 * The harness identity: the visual vocabulary of the "every way in" figure,
 * shared by every direction figure. A figure is a stack of bands on paper.
 * A band has a serif title with a sans subtitle, and rows that each carry a
 * mono label on the left and chips on the right. Chips in a sequence are
 * joined by small arrows. One inverted panel holds the thing that matters,
 * and a hairline and an italic sentence close the figure.
 *
 * Coordinates are absolute on a fixed canvas, as in the rest of the figure
 * system, so edges can be routed between bands in one SVG layer.
 */
export const MONO = "var(--font-mono)";
export const SANS = "var(--font-sans)";
export const SERIF = "var(--font-editorial)";
const DEEP = "var(--color-paper-deep)";

export interface At {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The accent on an inverted panel: lifted toward the panel's type so it reads in both themes. */
export function accentOnInverse(palette: FigurePalette): string {
  return `color-mix(in srgb, ${palette.accent} 62%, ${palette.inverseFg})`;
}

export function Band({
  palette,
  at,
  inverse = false,
  dashed = false,
  children,
  style,
}: {
  palette: FigurePalette;
  at: At;
  inverse?: boolean;
  dashed?: boolean;
  children?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: at.x,
        top: at.y,
        width: at.w,
        height: at.h,
        background: inverse ? palette.inverseBg : dashed ? "transparent" : DEEP,
        border: dashed ? `1px dashed ${palette.ink40}` : undefined,
        color: inverse ? palette.inverseFg : palette.ink,
        padding: "22px 24px",
        boxSizing: "border-box",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** A band's title: serif, with its subtitle beneath it or, `inline`, beside it. */
export function Title({
  palette,
  title,
  subtitle,
  inverse = false,
  inline = false,
  size = "2.15rem",
  style,
}: {
  palette: FigurePalette;
  title: ReactNode;
  subtitle?: ReactNode;
  inverse?: boolean;
  inline?: boolean;
  size?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: inline ? "row" : "column",
        alignItems: inline ? "baseline" : "flex-start",
        gap: inline ? 18 : 4,
        ...style,
      }}
    >
      <span
        style={{
          fontFamily: SERIF,
          fontWeight: 500,
          fontSize: size,
          lineHeight: 1.05,
          letterSpacing: "-0.02em",
          fontVariationSettings: '"opsz" 96, "SOFT" 30',
          color: inverse ? accentOnInverse(palette) : palette.ink,
        }}
      >
        {title}
      </span>
      {subtitle ? (
        <span
          style={{
            fontFamily: SANS,
            fontSize: "0.92rem",
            lineHeight: 1.35,
            color: inverse ? palette.inverseFg : palette.ink60,
            opacity: inverse ? 0.72 : 1,
          }}
        >
          {subtitle}
        </span>
      ) : null}
    </div>
  );
}

/** The mono label on the left of a row, or above a column. */
export function Label({
  palette,
  children,
  inverse = false,
  accent = false,
  style,
}: {
  palette: FigurePalette;
  children: ReactNode;
  inverse?: boolean;
  accent?: boolean;
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        fontFamily: MONO,
        fontSize: "0.7rem",
        letterSpacing: "0.18em",
        textTransform: "uppercase",
        lineHeight: 1.6,
        color: accent
          ? inverse
            ? accentOnInverse(palette)
            : palette.accent
          : inverse
            ? palette.inverseFg
            : palette.ink55,
        opacity: inverse && !accent ? 0.62 : 1,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

export type ChipTone = "plain" | "accent" | "strong" | "quiet";

/**
 * A chip: the "a thing" of the identity. `plain` sits on a band; `accent`
 * is yours, or the thing the figure is about; `strong` is an outcome or a
 * plate; `quiet` is a note that still needs a box.
 */
export function Chip({
  palette,
  children,
  tone = "plain",
  icon,
  sub,
  style,
}: {
  palette: FigurePalette;
  children: ReactNode;
  tone?: ChipTone;
  icon?: "lock" | "store";
  sub?: ReactNode;
  style?: CSSProperties;
}) {
  const tones: Record<ChipTone, CSSProperties> = {
    plain: {
      background: palette.paper,
      border: `1px solid ${palette.ink25}`,
      color: palette.ink,
    },
    accent: {
      background: palette.paper,
      border: `1.5px solid ${palette.accent}`,
      color: palette.accent,
    },
    strong: {
      background: palette.inverseBg,
      border: `1px solid ${palette.inverseBg}`,
      color: palette.inverseFg,
    },
    quiet: {
      background: "transparent",
      border: `1px dashed ${palette.ink40}`,
      color: palette.ink60,
    },
  };
  return (
    <span
      style={{
        fontFamily: MONO,
        fontSize: "0.79rem",
        letterSpacing: "0.02em",
        padding: sub ? "7px 11px" : "8px 11px",
        display: "inline-flex",
        flexDirection: sub ? "column" : "row",
        alignItems: sub ? "flex-start" : "center",
        gap: sub ? 3 : 8,
        whiteSpace: "nowrap",
        lineHeight: 1.2,
        boxSizing: "border-box",
        ...tones[tone],
        ...style,
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        {icon ? <Icon kind={icon} /> : null}
        {children}
      </span>
      {sub ? (
        <span
          style={{
            fontFamily: SANS,
            fontSize: "0.78rem",
            letterSpacing: 0,
            whiteSpace: "normal",
            opacity: 0.7,
            lineHeight: 1.3,
          }}
        >
          {sub}
        </span>
      ) : null}
    </span>
  );
}

function Icon({ kind }: { kind: "lock" | "store" }) {
  const common = {
    width: 11,
    height: 12,
    viewBox: "0 0 11 12",
    style: {
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.1,
      opacity: 0.6,
      flex: "none",
    },
  } as const;
  return kind === "lock" ? (
    <svg {...common}>
      <rect x="1.5" y="5.2" width="8" height="6" rx="0.8" />
      <path d="M3.3 5.2V3.6a2.2 2.2 0 0 1 4.4 0v1.6" />
    </svg>
  ) : (
    <svg {...common}>
      <ellipse cx="5.5" cy="2.6" rx="4" ry="1.6" />
      <path d="M1.5 2.6v6.8c0 0.9 1.8 1.6 4 1.6s4-0.7 4-1.6V2.6" />
      <path d="M1.5 6c0 0.9 1.8 1.6 4 1.6s4-0.7 4-1.6" />
    </svg>
  );
}

/** Chips joined by small arrows, read left to right. A string item is a plain chip. */
export function Seq({
  palette,
  items,
  lead = false,
  inverse = false,
  style,
}: {
  palette: FigurePalette;
  items: readonly ReactNode[];
  lead?: boolean;
  inverse?: boolean;
  style?: CSSProperties;
}) {
  const arrow = (
    <span
      style={{
        color: inverse ? palette.inverseFg : palette.ink40,
        opacity: inverse ? 0.55 : 1,
        fontSize: "0.8rem",
        lineHeight: 1,
      }}
    >
      →
    </span>
  );
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 7,
        ...style,
      }}
    >
      {lead ? arrow : null}
      {items.map((item, i) => (
        <Fragment key={i}>
          {i > 0 ? arrow : null}
          {typeof item === "string" ? (
            <Chip palette={palette}>{item}</Chip>
          ) : (
            item
          )}
        </Fragment>
      ))}
    </div>
  );
}

/** Chips in a wrapping row, no arrows. */
export function Chips({
  children,
  gap = 8,
  style,
}: {
  children: ReactNode;
  gap?: number;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** A labelled row inside a band: the label column, then the content. A divider above all but the first. */
export function Row({
  palette,
  label,
  children,
  inverse = false,
  divider = true,
  labelWidth = 150,
  style,
}: {
  palette: FigurePalette;
  label: ReactNode;
  children: ReactNode;
  inverse?: boolean;
  divider?: boolean;
  labelWidth?: number;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `${labelWidth}px 1fr`,
        gap: 16,
        padding: "11px 0",
        borderTop: divider
          ? `1px solid ${inverse ? `color-mix(in srgb, ${palette.inverseFg} 18%, transparent)` : palette.ink15}`
          : undefined,
        ...style,
      }}
    >
      <Label palette={palette} inverse={inverse} style={{ paddingTop: 8 }}>
        {label}
      </Label>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {children}
      </div>
    </div>
  );
}

/** Small mono text: an edge label or a footnote under a chip. */
export function Note({
  palette,
  children,
  accent = false,
  inverse = false,
  style,
}: {
  palette: FigurePalette;
  children: ReactNode;
  accent?: boolean;
  inverse?: boolean;
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        fontFamily: MONO,
        fontSize: "0.72rem",
        lineHeight: 1.45,
        color: accent
          ? inverse
            ? accentOnInverse(palette)
            : palette.accent
          : inverse
            ? palette.inverseFg
            : palette.ink55,
        opacity: inverse && !accent ? 0.65 : 1,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/** A note placed on the canvas. */
export function At({
  x,
  y,
  w,
  children,
  align = "left",
  rotate = false,
}: {
  x: number;
  y: number;
  w?: number;
  children: ReactNode;
  align?: "left" | "right" | "center";
  rotate?: boolean;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: w,
        textAlign: align,
        transformOrigin: "left top",
        transform: rotate ? "rotate(-90deg)" : undefined,
        whiteSpace: rotate ? "nowrap" : undefined,
      }}
    >
      {children}
    </div>
  );
}

export type EdgeKind = "plain" | "dashed" | "accent" | "faint";

/** Every edge of a figure, in one SVG layer over the canvas. `d` is a path in canvas coordinates. */
export function Edges({
  palette,
  width,
  height,
  edges,
}: {
  palette: FigurePalette;
  width: number;
  height: number;
  edges: readonly { d: string; kind: EdgeKind; head?: boolean }[];
}) {
  const color = (k: EdgeKind) =>
    k === "accent"
      ? palette.accent
      : k === "faint"
        ? palette.ink25
        : palette.ink40;
  return (
    <svg
      width={width}
      height={height}
      style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none" }}
    >
      <defs>
        {(["ink", "accent"] as const).map((m) => (
          <marker
            key={m}
            id={`harness-${m}`}
            viewBox="0 0 10 10"
            refX={9}
            refY={5}
            markerWidth={7}
            markerHeight={7}
            orient="auto-start-reverse"
          >
            <path
              d="M1,1 L9,5 L1,9"
              style={{
                fill: "none",
                stroke: m === "accent" ? palette.accent : palette.ink40,
                strokeWidth: 1.4,
              }}
            />
          </marker>
        ))}
      </defs>
      {edges.map((e, i) => (
        <path
          key={i}
          d={e.d}
          style={{
            fill: "none",
            stroke: color(e.kind),
            strokeWidth: e.kind === "accent" ? 1.5 : 1.2,
            strokeDasharray: e.kind === "dashed" ? "5 4" : undefined,
          }}
          markerEnd={
            e.head === false
              ? undefined
              : `url(#harness-${e.kind === "accent" ? "accent" : "ink"})`
          }
        />
      ))}
    </svg>
  );
}

/** The closing hairline and sentence, the second half in the accent. */
export function Conclusion({
  palette,
  y,
  width,
  plain,
  accent,
}: {
  palette: FigurePalette;
  y: number;
  width: number;
  plain: ReactNode;
  accent: ReactNode;
}) {
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 72,
          top: y,
          width: width - 144,
          height: 1,
          background: palette.ink15,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          top: y + 28,
          width,
          textAlign: "center",
          fontFamily: SERIF,
          fontStyle: "italic",
          fontSize: "2rem",
          fontVariationSettings: '"opsz" 144, "SOFT" 100',
          color: palette.ink60,
        }}
      >
        {plain} <span style={{ color: palette.accent }}>{accent}</span>
      </div>
    </>
  );
}

/** A panel inside a band, in the flow: inverted for the thing that matters, paper otherwise. */
export function Inset({
  palette,
  inverse = false,
  children,
  style,
}: {
  palette: FigurePalette;
  inverse?: boolean;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        background: inverse ? palette.inverseBg : palette.paper,
        color: inverse ? palette.inverseFg : palette.ink,
        border: inverse ? undefined : `1px solid ${palette.ink15}`,
        padding: "18px 20px",
        boxSizing: "border-box",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** A fault code: named, owned, and the reason the step it sits beside can refuse. */
export function Fault({
  palette,
  children,
}: {
  palette: FigurePalette;
  children: ReactNode;
}) {
  return (
    <span
      style={{
        fontFamily: MONO,
        fontSize: "0.72rem",
        letterSpacing: "0.06em",
        color: palette.accent,
        border: `1px solid ${palette.accent40}`,
        padding: "4px 8px",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}
