import {
  Arrow,
  Block,
  Body,
  Chip,
  Eyebrow,
  FigureCanvas,
  MonoNote,
  Subhead,
} from "./primitives.tsx";
import type { FigurePalette } from "./palette.ts";
import type { FigureDrawing, FigureProps, MotifProps } from "./types.ts";

const WIDTH = 1600;
const HEIGHT = 640;

interface Socket {
  name: string;
  what: string;
  builds: string;
}

const SOCKETS: Socket[] = [
  {
    name: "PORT",
    what: "offer a capability, or ask for one, by contract rather than by plugin name",
    builds: "a provider: a store, an authority, an HTTP server",
  },
  {
    name: "CONTRIBUTION",
    what: "a handler at a named moment, or a wrapper around the route, placed by anchor",
    builds: "a layer such as retry; a handler such as an audit log",
  },
  {
    name: "STEP",
    what: "an instruction a route can run, returning an outcome rather than nothing",
    builds: "an adapter in .from() or .to(); an operation such as .transform()",
  },
  {
    name: "FACET",
    what: "typed data under your own name on the exchange, gone from the types when you are not installed",
    builds: "ex.auth.principal, ex.deferral.id",
  },
];

function SocketCard({ s, palette }: { s: Socket; palette: FigurePalette }) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 14 }}>
      <Block
        palette={palette}
        style={{ height: 72, fontSize: "1.15rem", letterSpacing: "0.16em" }}
      >
        {s.name}
      </Block>
      <Body palette={palette} size="1.12rem" style={{ minHeight: 96 }}>
        {s.what}
      </Body>
      <div style={{ height: 1, background: palette.ink15 }} />
      <MonoNote palette={palette} size="0.95rem" style={{ lineHeight: 1.5 }}>
        <span style={{ color: palette.ink40 }}>you build </span>
        {s.builds}
      </MonoNote>
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
          gap: 26,
        }}
      >
        <Eyebrow palette={palette} accent>
          A plugin does exactly four things
        </Eyebrow>
        <Subhead palette={palette} size="2rem">
          Four sockets. Everything we ship is built from them, and so is
          everything you ship.
        </Subhead>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 22,
            marginTop: 10,
          }}
        >
          <Chip
            palette={palette}
            style={{
              fontSize: "1.2rem",
              padding: "22px 30px",
              flexDirection: "column",
              gap: 4,
            }}
          >
            a plugin
            <span
              style={{
                fontSize: "0.9rem",
                color: palette.ink55,
                letterSpacing: "0.1em",
              }}
            >
              ours or yours
            </span>
          </Chip>
          <Arrow palette={palette} size="2rem">
            →
          </Arrow>
          <div style={{ flex: 1, display: "flex", gap: 28 }}>
            {SOCKETS.map((s) => (
              <SocketCard key={s.name} s={s} palette={palette} />
            ))}
          </div>
        </div>
        <MonoNote
          palette={palette}
          accent
          size="1.05rem"
          style={{ marginTop: "auto" }}
        >
          there is no fifth socket that only we may use
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
        alignItems: "center",
        justifyContent: "center",
        gap: u * 6,
      }}
    >
      <div
        style={{ width: u * 18, height: u * 18, backgroundColor: palette.fg }}
      />
      <div
        style={{
          width: u * 8,
          height: u * 2,
          backgroundColor: palette.muted55,
        }}
      />
      <div
        style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: u * 5 }}
      >
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            style={{
              width: u * 20,
              height: u * 20,
              border: `${Math.max(2, u * 1.6)}px solid ${palette.accent}`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

export const fourSockets: FigureDrawing = {
  id: "four-sockets",
  width: WIDTH,
  height: HEIGHT,
  Figure,
  Motif,
};
