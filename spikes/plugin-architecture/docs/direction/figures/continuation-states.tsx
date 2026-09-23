import {
  Body,
  Eyebrow,
  FigureCanvas,
  MonoNote,
  Subhead,
} from "./primitives.tsx";
import { Edge, Node, Terminal } from "./flow.tsx";
import type { FigurePalette } from "./palette.ts";
import type { FigureDrawing, FigureProps, MotifProps } from "./types.ts";

const WIDTH = 1600;
const HEIGHT = 760;

function State({
  palette,
  name,
  note,
  accent = false,
  style,
}: {
  palette: FigurePalette;
  name: string;
  note: string;
  accent?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        border: `${accent ? 2 : 1}px solid ${accent ? palette.accent : palette.ink35}`,
        padding: "18px 22px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        background: palette.paper,
        ...style,
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "1.15rem",
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: accent ? palette.accent : palette.ink,
        }}
      >
        {name}
      </span>
      <span
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: "0.98rem",
          lineHeight: 1.4,
          color: palette.ink60,
        }}
      >
        {note}
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
          padding: "72px 80px 56px",
          gap: 18,
        }}
      >
        <Eyebrow palette={palette} accent>
          A parked exchange, over its life
        </Eyebrow>
        <Subhead palette={palette} size="1.9rem">
          Two mechanisms, deliberately different: a resume is won once, a
          notification is leased and may be re-sent.
        </Subhead>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "520px 230px 1fr",
            gridTemplateRows: "auto auto",
            columnGap: 0,
            rowGap: 28,
            marginTop: 16,
            alignItems: "center",
          }}
        >
          <div
            style={{
              gridRow: "1 / span 2",
              border: `1px dashed ${palette.ink40}`,
              padding: "18px 20px",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "1.15rem",
                letterSpacing: "0.14em",
                color: palette.ink,
              }}
            >
              WAITING
            </span>
            <Node
              palette={palette}
              title="unclaimed"
              body="written with its index in one transaction when the exchange parked; claimExpiry claims it once it is due or its plan has changed"
            />
            <div style={{ display: "flex", justifyContent: "center", gap: 40 }}>
              <Edge palette={palette} length={26} label="claimExpiry" />
              <Edge
                palette={palette}
                direction="up"
                length={26}
                label="releaseClaims"
              />
            </div>
            <Node
              palette={palette}
              title="claimed"
              body="a notification holds a lease and excludes a resume; releaseClaims returns it when the lease elapses, and the nag is re-sent"
            />
          </div>
          <Edge
            palette={palette}
            direction="right"
            accent
            length={130}
            label="markResumed, from unclaimed only"
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <State
              palette={palette}
              accent
              name="resumed"
              note="a compare-and-swap out of unclaimed: exactly one caller wins, and the record says who"
            />
            <Body palette={palette} size="0.95rem">
              A second resume is answered from the record with how the first one
              ended, and runs nothing. A winner that dies before recording its
              outcome is reported at the next start and never re-run: the steps
              after the park may have half happened.
            </Body>
          </div>
          <Edge
            palette={palette}
            direction="right"
            length={130}
            label="from claimed, once delivered"
          />
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
              alignItems: "stretch",
            }}
          >
            <State
              palette={palette}
              name="expired"
              note="markExpired, after the nag was delivered"
            />
            <State
              palette={palette}
              name="denied"
              note="markDenied, after a changed plan or a failed notification was reported"
            />
            <div
              style={{
                gridColumn: "1 / span 2",
                display: "flex",
                alignItems: "center",
                gap: 16,
              }}
            >
              <Edge
                palette={palette}
                direction="right"
                length={80}
                label="purgeSettled, past retention"
              />
              <Terminal palette={palette} style={{ flex: 1 }}>
                gone, with resumed
              </Terminal>
            </div>
          </div>
        </div>
        <MonoNote
          palette={palette}
          size="1rem"
          style={{ marginTop: "auto", lineHeight: 1.6 }}
        >
          from claimed, only expired or denied; from unclaimed, only resumed. a
          resume is never the lease.
        </MonoNote>
      </div>
    </FigureCanvas>
  );
}

function Motif({ palette, size }: MotifProps) {
  const u = size / 100;
  const s = Math.max(2, u * 1.5);
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
        style={{
          width: u * 24,
          height: u * 24,
          border: `${s}px dashed ${palette.muted55}`,
        }}
      />
      <div
        style={{ width: u * 10, height: s, backgroundColor: palette.muted40 }}
      />
      <div
        style={{
          width: u * 24,
          height: u * 24,
          border: `${s * 1.5}px solid ${palette.accent}`,
        }}
      />
    </div>
  );
}

export const continuationStates: FigureDrawing = {
  id: "continuation-states",
  width: WIDTH,
  height: HEIGHT,
  Figure,
  Motif,
};
