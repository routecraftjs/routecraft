import type { CSSProperties, ReactNode } from "react";

import type { FigurePalette } from "./palette.ts";

/**
 * Flow vocabulary shared by the direction figures, on top of `primitives.tsx`:
 * a node with an optional second line, a labelled connector, and a terminal
 * state drawn as a plate. Same fonts and palette keys, so a figure built from
 * these still reads as one system with the site's blog figures.
 */
const MONO = "var(--font-mono)";

export function Node({
  palette,
  title,
  body,
  accent = false,
  style,
}: {
  palette: FigurePalette;
  title: ReactNode;
  body?: ReactNode;
  accent?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        border: `${accent ? 2 : 1}px solid ${accent ? palette.accent : palette.ink35}`,
        background: palette.paper,
        padding: "14px 20px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        gap: 4,
        ...style,
      }}
    >
      <span
        style={{
          fontFamily: MONO,
          fontSize: "1.15rem",
          letterSpacing: "0.04em",
          color: accent ? palette.accent : palette.ink,
          whiteSpace: "nowrap",
        }}
      >
        {title}
      </span>
      {body ? (
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "0.98rem",
            lineHeight: 1.35,
            color: palette.ink60,
          }}
        >
          {body}
        </span>
      ) : null}
    </div>
  );
}

/** Terminal outcome: an inverted plate for the happy end, a hairline plate otherwise. */
export function Terminal({
  palette,
  children,
  tone = "plain",
  style,
}: {
  palette: FigurePalette;
  children: ReactNode;
  tone?: "plain" | "inverse" | "accent";
  style?: CSSProperties;
}) {
  const base: CSSProperties = {
    fontFamily: MONO,
    fontSize: "1.05rem",
    letterSpacing: "0.16em",
    textTransform: "uppercase",
    padding: "12px 22px",
    textAlign: "center",
    whiteSpace: "nowrap",
    borderRadius: 999,
  };
  const tones: Record<typeof tone, CSSProperties> = {
    plain: { border: `1px solid ${palette.ink35}`, color: palette.ink60 },
    inverse: { background: palette.inverseBg, color: palette.inverseFg },
    accent: { border: `2px solid ${palette.accent}`, color: palette.accent },
  };
  return <div style={{ ...base, ...tones[tone], ...style }}>{children}</div>;
}

/** A connector with a label beside the arrow head. */
export function Edge({
  palette,
  label,
  direction = "down",
  accent = false,
  length = 44,
  style,
}: {
  palette: FigurePalette;
  label?: ReactNode;
  direction?: "down" | "up" | "right";
  accent?: boolean;
  length?: number;
  style?: CSSProperties;
}) {
  const color = accent ? palette.accent : palette.ink40;
  const vertical = direction !== "right";
  const line = (
    <div
      style={{
        position: "relative",
        width: vertical ? 1 : length,
        height: vertical ? length : 1,
        background: color,
        flex: "none",
      }}
    >
      <span
        style={{
          position: "absolute",
          color,
          fontSize: "1.2rem",
          lineHeight: 1,
          ...(vertical
            ? direction === "up"
              ? { left: "50%", top: -9, transform: "translateX(-50%)" }
              : { left: "50%", bottom: -9, transform: "translateX(-50%)" }
            : { top: "50%", right: -9, transform: "translateY(-50%)" }),
        }}
      >
        {direction === "up" ? "▴" : vertical ? "▾" : "▸"}
      </span>
    </div>
  );
  const text = label ? (
    <span
      style={{
        fontFamily: MONO,
        fontSize: "0.9rem",
        color: accent ? palette.accent : palette.ink55,
        whiteSpace: vertical ? "nowrap" : "normal",
        textAlign: "center",
        maxWidth: vertical ? undefined : length + 90,
        lineHeight: 1.3,
      }}
    >
      {label}
    </span>
  ) : null;
  return vertical ? (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        ...style,
      }}
    >
      {line}
      {text}
    </div>
  ) : (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6,
        ...style,
      }}
    >
      {line}
      {text}
    </div>
  );
}

/** Small mono tag, used for error codes and run kinds. */
export function Tag({
  palette,
  children,
  accent = false,
  style,
}: {
  palette: FigurePalette;
  children: ReactNode;
  accent?: boolean;
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        fontFamily: MONO,
        fontSize: "0.85rem",
        letterSpacing: "0.06em",
        color: accent ? palette.accent : palette.ink55,
        border: `1px solid ${accent ? palette.accent40 : palette.ink25}`,
        padding: "3px 8px",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {children}
    </span>
  );
}
