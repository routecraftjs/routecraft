import { FigureCanvas } from "./primitives.tsx";
import {
  Band,
  Chip,
  Chips,
  Conclusion,
  Inset,
  Label,
  Note,
  Row,
  SANS,
  SERIF,
  Title,
} from "./harness.tsx";
import type { FigurePalette } from "./palette.ts";
import type { FigureDrawing, FigureProps, MotifProps } from "./types.ts";

/** The four sockets you build with, what each builds, and the two more that reach the kernel. */
const WIDTH = 1600;
const HEIGHT = 660;

function Socket({
  palette,
  name,
  what,
  builds,
}: {
  palette: FigurePalette;
  name: string;
  what: string;
  builds: readonly string[];
}) {
  return (
    <Inset
      palette={palette}
      style={{ display: "flex", flexDirection: "column", gap: 10 }}
    >
      <span
        style={{
          fontFamily: SERIF,
          fontSize: "1.6rem",
          lineHeight: 1.05,
          letterSpacing: "-0.02em",
        }}
      >
        {name}
      </span>
      <span
        style={{
          fontFamily: SANS,
          fontSize: "0.9rem",
          lineHeight: 1.4,
          color: palette.ink60,
          minHeight: 50,
        }}
      >
        {what}
      </span>
      <Label palette={palette}>You build</Label>
      <Chips gap={6}>
        {builds.map((b) => (
          <Chip key={b} palette={palette} tone="accent">
            {b}
          </Chip>
        ))}
      </Chips>
    </Inset>
  );
}

function Figure({ palette }: FigureProps) {
  return (
    <FigureCanvas palette={palette} width={WIDTH} height={HEIGHT}>
      <Band palette={palette} at={{ x: 150, y: 80, w: 1300, h: 420 }}>
        <Title
          palette={palette}
          inline
          title="Four sockets"
          subtitle="everything we ship is built from them, and so is everything you ship"
        />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 12,
            marginTop: 20,
          }}
        >
          <Socket
            palette={palette}
            name="Port"
            what="Offer a capability, or ask for one, by contract rather than by plugin name."
            builds={["a store", "an authority", "an HTTP server"]}
          />
          <Socket
            palette={palette}
            name="Contribution"
            what="A handler at a named moment, or a wrapper around the route, placed by anchor."
            builds={["a layer like retry", "an audit handler"]}
          />
          <Socket
            palette={palette}
            name="Step"
            what="An instruction a route runs, returning an outcome rather than nothing."
            builds={["an adapter", "an operation"]}
          />
          <Socket
            palette={palette}
            name="Facet"
            what="Typed data under your own name on the exchange, absent from the types when you are not installed."
            builds={["ex.approvals"]}
          />
        </div>
        <Row
          palette={palette}
          label="Also reaching the kernel"
          labelWidth={230}
          style={{ marginTop: 16 }}
        >
          <Chips>
            <Chip
              palette={palette}
              sub="a moment you declare, with the decisions it honours"
            >
              POINT
            </Chip>
            <Chip
              palette={palette}
              sub="deliver · resume · sweep: verbs every plugin is handed"
            >
              EXECUTION
            </Chip>
            <Note palette={palette} style={{ marginLeft: 8 }}>
              six in all; none of them is ours alone
            </Note>
          </Chips>
        </Row>
      </Band>
      <Conclusion
        palette={palette}
        y={540}
        width={WIDTH}
        plain="There is no socket"
        accent="that only we may use."
      />
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
