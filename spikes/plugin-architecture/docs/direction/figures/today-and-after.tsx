import {
  Arrow,
  Block,
  Chip,
  Eyebrow,
  FigureCanvas,
  MonoNote,
  Plate,
  Subhead,
} from "./primitives.tsx";
import type { FigurePalette } from "./palette.ts";
import type { FigureDrawing, FigureProps, MotifProps } from "./types.ts";

const WIDTH = 1600;
const HEIGHT = 720;

const FEATURES = [
  "routes · DSL",
  "deferral · resilience · auth",
  "agents · stores · HTTP",
];

function Today({ palette }: { palette: FigurePalette }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      <Eyebrow palette={palette}>Today</Eyebrow>
      <Subhead palette={palette} size="2rem">
        Our features are inside. Yours are at the window.
      </Subhead>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 26,
          marginTop: 12,
        }}
      >
        <div
          style={{
            border: `1px dashed ${palette.ink40}`,
            padding: "18px 22px",
            fontFamily: "var(--font-mono)",
            fontSize: "1.15rem",
            color: palette.ink60,
            textAlign: "center",
            lineHeight: 1.5,
          }}
        >
          your plugin
          <br />
          <span style={{ color: palette.ink40, fontSize: "0.95rem" }}>
            apply(ctx)
          </span>
        </div>
        <Arrow palette={palette} size="2rem">
          ⇢
        </Arrow>
        <div
          style={{
            flex: 1,
            background: palette.inverseBg,
            color: palette.inverseFg,
            padding: "30px 34px",
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "1.1rem",
              letterSpacing: "0.22em",
              opacity: 0.7,
            }}
          >
            ROUTECRAFT
          </span>
          {FEATURES.map((f) => (
            <span
              key={f}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "1.2rem",
                border: `1px solid ${palette.inverseFg}`,
                opacity: 0.9,
                padding: "12px 18px",
              }}
            >
              {f}
            </span>
          ))}
        </div>
      </div>
      <MonoNote
        palette={palette}
        size="1.15rem"
        style={{ marginTop: 8, lineHeight: 1.6 }}
      >
        one verb, the whole context, private paths for us
      </MonoNote>
    </div>
  );
}

function After({ palette }: { palette: FigurePalette }) {
  const blocks = [
    { label: "deferral", ours: true },
    { label: "resilience", ours: true },
    { label: "auth", ours: true },
    { label: "your store", ours: false },
    { label: "your steps", ours: false },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      <Eyebrow palette={palette} accent>
        After
      </Eyebrow>
      <Subhead palette={palette} size="2rem">
        Every feature is a plugin. Ours and yours, the same sockets.
      </Subhead>
      <div style={{ display: "flex", gap: 14, marginTop: 12 }}>
        {blocks.map((b) => (
          <div
            key={b.label}
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 10,
            }}
          >
            {b.ours ? (
              <Chip
                palette={palette}
                style={{
                  width: "100%",
                  height: 88,
                  fontSize: "1.1rem",
                  padding: "0 10px",
                }}
              >
                {b.label}
              </Chip>
            ) : (
              <Block
                palette={palette}
                style={{
                  width: "100%",
                  height: 88,
                  fontSize: "1.1rem",
                  padding: "0 10px",
                }}
              >
                {b.label}
              </Block>
            )}
            <Arrow palette={palette} size="1.6rem">
              ↓
            </Arrow>
          </div>
        ))}
      </div>
      <Plate
        palette={palette}
        style={{ padding: "26px 20px", fontSize: "1.2rem" }}
      >
        KERNEL · lifecycle · contracts · the continuation protocol
      </Plate>
      <MonoNote
        palette={palette}
        accent
        size="1.15rem"
        style={{ marginTop: 8, lineHeight: 1.6 }}
      >
        five identical arrows; the kernel cannot tell whose they are
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
          display: "grid",
          gridTemplateColumns: "1fr 1px 1fr",
          gap: 56,
          padding: "80px 80px 64px",
        }}
      >
        <Today palette={palette} />
        <div style={{ background: palette.ink15 }} />
        <After palette={palette} />
      </div>
    </FigureCanvas>
  );
}

/** Motif: a wall with one thing outside it, beside five equal posts on one bar. */
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
        gap: u * 8,
      }}
    >
      <div
        style={{ width: u * 30, height: u * 44, backgroundColor: palette.fg }}
      />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: u * 6,
        }}
      >
        <div style={{ display: "flex", gap: u * 4 }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              style={{
                width: u * 7,
                height: u * 22,
                border: `${Math.max(2, u * 1.4)}px solid ${i > 2 ? palette.accent : palette.muted55}`,
              }}
            />
          ))}
        </div>
        <div
          style={{ width: u * 51, height: u * 10, backgroundColor: palette.fg }}
        />
      </div>
    </div>
  );
}

export const todayAndAfter: FigureDrawing = {
  id: "today-and-after",
  width: WIDTH,
  height: HEIGHT,
  Figure,
  Motif,
};
