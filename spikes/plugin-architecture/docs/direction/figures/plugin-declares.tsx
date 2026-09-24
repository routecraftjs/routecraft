import {
  Arrow,
  Body,
  Eyebrow,
  FigureCanvas,
  MonoNote,
  Plate,
  Subhead,
} from "./primitives.tsx";
import { Tag } from "./flow.tsx";
import type { FigurePalette } from "./palette.ts";
import type { FigureDrawing, FigureProps, MotifProps } from "./types.ts";

const WIDTH = 1600;
const HEIGHT = 1120;

function Row({
  palette,
  k,
  v,
  accent = false,
}: {
  palette: FigurePalette;
  k: string;
  v: string;
  accent?: boolean;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "150px 1fr",
        gap: 18,
        alignItems: "baseline",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "1.05rem",
          color: accent ? palette.accent : palette.ink55,
          letterSpacing: "0.06em",
        }}
      >
        {k}
      </span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "1.05rem",
          color: palette.ink,
          lineHeight: 1.5,
        }}
      >
        {v}
      </span>
    </div>
  );
}

function Figure({ palette }: FigureProps) {
  return (
    <FigureCanvas palette={palette} width={WIDTH} height={HEIGHT}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          padding: "72px 80px 60px",
          gap: 24,
        }}
      >
        <Eyebrow palette={palette} accent>
          What a plugin is
        </Eyebrow>
        <Subhead palette={palette} size="2rem">
          A plain object that declares, then binds. You never wire it and never
          decide when it starts.
        </Subhead>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 60px 1fr",
            gap: 24,
            marginTop: 12,
            alignItems: "stretch",
          }}
        >
          <div
            style={{
              border: `2px solid ${palette.accent}`,
              padding: "28px 32px",
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}
          >
            <MonoNote
              palette={palette}
              accent
              size="0.95rem"
              style={{ letterSpacing: "0.2em" }}
            >
              YOUR PLUGIN
            </MonoNote>
            <Row
              palette={palette}
              k="id"
              v="acme.approvals · namespace: approvals"
              accent
            />
            <Row
              palette={palette}
              k="requires"
              v="[CONTINUATIONS]  a capability, never a plugin"
            />
            <Row
              palette={palette}
              k="provides"
              v="[APPROVALS]  a port others may require"
            />
            <Row
              palette={palette}
              k="replaces"
              v="[]  or a default provider this one displaces"
            />
            <Row
              palette={palette}
              k="points"
              v="[approval.decided]  a moment handlers may join"
            />
            <Row
              palette={palette}
              k="facets"
              v="{ approvals: ex => ... }  typed as ex.approvals"
            />
            <Row
              palette={palette}
              k="methods"
              v="() => ({ approve })  a step on every route builder"
            />
            <div style={{ height: 1, background: palette.accent40 }} />
            <Row
              palette={palette}
              k="bind(c)"
              v="c.require(CONTINUATIONS)  ·  c.provide(APPROVALS, service)"
              accent
            />
            <Row
              palette={palette}
              k=""
              v="c.contribute(handler | wrapper)  placed by anchor"
            />
            <Row
              palette={palette}
              k=""
              v="c.observe(event => ...)  ·  c.emit(name, data)"
            />
            <Row palette={palette} k="" v="c.onDispose(() => ...)" />
            <div style={{ height: 1, background: palette.accent40 }} />
            <Row
              palette={palette}
              k="start / stop"
              v="acquire once every route has compiled; release in reverse"
            />
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Arrow palette={palette} size="2.2rem">
              →
            </Arrow>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <Plate
              palette={palette}
              style={{ padding: "22px 20px", fontSize: "1.1rem" }}
            >
              ROUTECRAFT
            </Plate>
            {[
              [
                "orders",
                "by what you require and provide; a cycle or a missing provider is refused at start, by name",
              ],
              [
                "namespaces",
                "your facet, options, handlers and events live under acme.*; two plugins cannot collide on a string",
              ],
              [
                "freezes",
                "after bind: a contribution that arrives from start() would miss the composed chain, so it is refused",
              ],
              ["starts", "in dependency order, once every route has compiled"],
              [
                "stops",
                "in reverse, consumers before providers, failures aggregated",
              ],
            ].map(([k, v]) => (
              <div
                key={k}
                style={{
                  display: "grid",
                  gridTemplateColumns: "150px 1fr",
                  gap: 18,
                  alignItems: "baseline",
                }}
              >
                <Tag palette={palette}>{k}</Tag>
                <Body palette={palette} size="1.05rem">
                  {v}
                </Body>
              </div>
            ))}
          </div>
        </div>
        <MonoNote palette={palette} size="1rem" style={{ marginTop: "auto" }}>
          the same object shape for every plugin we ship
        </MonoNote>
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
        gap: u * 6,
      }}
    >
      <div
        style={{
          width: u * 56,
          height: u * 40,
          border: `${Math.max(2, u * 1.6)}px solid ${palette.accent}`,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-evenly",
          padding: `0 ${u * 8}px`,
        }}
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            style={{
              height: u * 2.5,
              backgroundColor: palette.muted55,
              width: `${60 + i * 15}%`,
            }}
          />
        ))}
      </div>
      <div
        style={{ width: u * 56, height: u * 12, backgroundColor: palette.fg }}
      />
    </div>
  );
}

export const pluginDeclares: FigureDrawing = {
  id: "plugin-declares",
  width: WIDTH,
  height: HEIGHT,
  Figure,
  Motif,
};
