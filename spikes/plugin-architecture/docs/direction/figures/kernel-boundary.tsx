import {
  Block,
  Chip,
  Eyebrow,
  FigureCanvas,
  MonoNote,
  Subhead,
} from "./primitives.tsx";
import { Edge } from "./flow.tsx";
import type { FigurePalette } from "./palette.ts";
import type { FigureDrawing, FigureProps, MotifProps } from "./types.ts";

const WIDTH = 1600;
const HEIGHT = 780;

function Contract({
  palette,
  name,
  note,
}: {
  palette: FigurePalette;
  name: string;
  note: string;
}) {
  return (
    <div
      style={{
        flex: 1,
        border: `1px solid ${palette.ink35}`,
        padding: "16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        background: palette.paper,
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "1.1rem",
          color: palette.ink,
        }}
      >
        {name}
      </span>
      <span
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: "0.95rem",
          color: palette.ink60,
          lineHeight: 1.35,
        }}
      >
        {note}
      </span>
    </div>
  );
}

function Figure({ palette }: FigureProps) {
  const chip = { fontSize: "1.05rem", padding: "14px 20px" };
  return (
    <FigureCanvas palette={palette} width={WIDTH} height={HEIGHT}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          padding: "72px 80px 56px",
          gap: 22,
        }}
      >
        <Eyebrow palette={palette} accent>
          What the kernel owns
        </Eyebrow>
        <Subhead palette={palette} size="2rem">
          Lifecycle, contracts and the continuation protocol. Nothing else, and
          no opinion about what plugs in.
        </Subhead>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 0,
            marginTop: 8,
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "190px 1fr 1fr",
              gap: 24,
              alignItems: "start",
            }}
          >
            <Eyebrow
              palette={palette}
              style={{ fontSize: "0.95rem", paddingTop: 20 }}
            >
              PLUGINS
            </Eyebrow>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.85rem",
                  letterSpacing: "0.18em",
                  color: palette.ink55,
                }}
              >
                FIRST PARTY
              </span>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                {[
                  "operations",
                  "resilience",
                  "deferral",
                  "sqlite",
                  "principals",
                  "auth",
                ].map((n) => (
                  <Chip key={n} palette={palette} style={chip}>
                    {n}
                  </Chip>
                ))}
              </div>
              <Edge
                palette={palette}
                label="require · provide · contribute · observe"
                length={40}
                style={{ alignSelf: "flex-start", marginLeft: 120 }}
              />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.85rem",
                  letterSpacing: "0.18em",
                  color: palette.accent,
                }}
              >
                THIRD PARTY
              </span>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <Block
                  palette={palette}
                  style={{ ...chip, padding: "13px 20px" }}
                >
                  acme.store · provides CONTINUATIONS, replacing ours
                </Block>
                <Block
                  palette={palette}
                  style={{ ...chip, padding: "13px 20px" }}
                >
                  acme.inspect · declares a handler point
                </Block>
              </div>
              <Edge
                palette={palette}
                accent
                label="require · provide · contribute · observe"
                length={40}
                style={{ alignSelf: "flex-start", marginLeft: 120 }}
              />
            </div>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "190px 1fr",
              gap: 24,
              alignItems: "center",
            }}
          >
            <Eyebrow palette={palette} style={{ fontSize: "0.95rem" }}>
              CONTRACTS
            </Eyebrow>
            <div style={{ display: "flex", gap: 14 }}>
              <Contract
                palette={palette}
                name="Port<T>"
                note="a named capability; one provider is resolved for it"
              />
              <Contract
                palette={palette}
                name="Contribution"
                note="Handler at a point, or Wrapper around the route; placed by anchor; scoped to run kinds"
              />
              <Contract
                palette={palette}
                name="Step"
                note="an instruction returning one of six outcomes"
              />
              <Contract
                palette={palette}
                name="Facet"
                note="typed data under a namespace"
              />
              <Contract
                palette={palette}
                name="Point"
                note="a moment, with the decisions it honours"
              />
            </div>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "190px 1fr",
              alignItems: "center",
            }}
          >
            <span />
            <Edge
              palette={palette}
              label="defined here, implemented by nobody here"
              length={40}
            />
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "190px 1fr",
              gap: 24,
              alignItems: "center",
            }}
          >
            <Eyebrow palette={palette} style={{ fontSize: "0.95rem" }}>
              KERNEL
            </Eyebrow>
            <div
              style={{
                background: palette.inverseBg,
                color: palette.inverseFg,
                padding: "26px 30px",
                display: "grid",
                gridTemplateColumns: "repeat(5, 1fr)",
                gap: 20,
              }}
            >
              {[
                ["lifecycle", "bind, freeze, start, stop"],
                ["resolution", "ports to one provider"],
                ["ordering", "anchors and constraints"],
                ["execution", "the step loop and the rings"],
                ["continuation", "park, claim, resume, settle"],
              ].map(([k, v]) => (
                <div
                  key={k}
                  style={{ display: "flex", flexDirection: "column", gap: 6 }}
                >
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "1.05rem",
                      letterSpacing: "0.14em",
                      textTransform: "uppercase",
                    }}
                  >
                    {k}
                  </span>
                  <span
                    style={{
                      fontFamily: "var(--font-sans)",
                      fontSize: "0.95rem",
                      opacity: 0.75,
                      lineHeight: 1.35,
                    }}
                  >
                    {v}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <MonoNote palette={palette} size="1rem" style={{ marginTop: "auto" }}>
          the kernel cannot import a plugin: the dependency direction is
          checked, not promised
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
        gap: u * 7,
      }}
    >
      <div style={{ display: "flex", gap: u * 5 }}>
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            style={{
              width: u * 12,
              height: u * 12,
              border: `${Math.max(2, u * 1.5)}px solid ${i === 3 ? palette.accent : palette.muted55}`,
            }}
          />
        ))}
      </div>
      <div
        style={{
          width: u * 63,
          height: u * 3,
          backgroundColor: palette.muted40,
        }}
      />
      <div
        style={{ width: u * 63, height: u * 16, backgroundColor: palette.fg }}
      />
    </div>
  );
}

export const kernelBoundary: FigureDrawing = {
  id: "kernel-boundary",
  width: WIDTH,
  height: HEIGHT,
  Figure,
  Motif,
};
