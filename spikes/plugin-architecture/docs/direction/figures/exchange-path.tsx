import {
  Chip,
  Eyebrow,
  FigureCanvas,
  MonoNote,
  Subhead,
} from "./primitives.tsx";
import { Edge, Node, Tag, Terminal } from "./flow.tsx";
import type { FigurePalette } from "./palette.ts";
import type { FigureDrawing, FigureProps, MotifProps } from "./types.ts";

const WIDTH = 1600;
const HEIGHT = 1190;

function Column({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Side({
  palette,
  title,
  rows,
  accent = false,
}: {
  palette: FigurePalette;
  title: string;
  rows: [string, string][];
  accent?: boolean;
}) {
  return (
    <div
      style={{
        border: `1px ${accent ? "solid" : "dashed"} ${accent ? palette.accent40 : palette.ink40}`,
        padding: "16px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        width: "100%",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.9rem",
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: accent ? palette.accent : palette.ink55,
        }}
      >
        {title}
      </span>
      {rows.map(([k, v]) => (
        <div
          key={k}
          style={{
            display: "grid",
            gridTemplateColumns: "92px 1fr",
            gap: 12,
            alignItems: "baseline",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "1rem",
              color: palette.ink,
            }}
          >
            {k}
          </span>
          <span
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "0.95rem",
              color: palette.ink60,
              lineHeight: 1.35,
            }}
          >
            {v}
          </span>
        </div>
      ))}
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
          One exchange through a route
        </Eyebrow>
        <Subhead palette={palette} size="1.9rem">
          Rings around a step loop. A step returns an outcome, which is how a
          plugin gets to halt, branch or park.
        </Subhead>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "400px 1fr 400px",
            columnGap: 40,
            marginTop: 8,
            alignItems: "start",
          }}
        >
          {/* left: outcomes */}
          <Column style={{ paddingTop: 318, gap: 16 }}>
            <Side
              palette={palette}
              title="the six outcomes"
              rows={[
                ["continue", "hand the exchange to the next step"],
                ["complete", "stop here; what pends is done"],
                [
                  "drop",
                  "stop here; nothing reaches the caller or the exit ring",
                ],
                ["branch", "splice the chosen children ahead of what pends"],
                [
                  "fanOut",
                  "schedule every child; siblings pend; no child may park",
                ],
                ["defer", "persist a continuation at this step and halt"],
              ]}
            />
            <Edge
              palette={palette}
              label="defer: the record is written, then notify runs"
              length={34}
            />
            <Terminal
              palette={palette}
              tone="inverse"
              style={{ alignSelf: "stretch" }}
            >
              deferred
            </Terminal>
            <MonoNote
              palette={palette}
              size="0.85rem"
              style={{ alignSelf: "flex-start" }}
            >
              the process may exit; the exchange is in the store
            </MonoNote>
          </Column>
          {/* spine */}
          <Column>
            <Chip
              palette={palette}
              style={{ fontSize: "1.05rem", padding: "12px 22px" }}
            >
              deliver · resume · debounce · errorChannel
            </Chip>
            <Edge
              palette={palette}
              length={30}
              label="run kind decides which contributions apply"
            />
            <Node
              palette={palette}
              title="admission ring"
              body="handlers may decorate or refuse; the door of a resume runs here"
              style={{ width: "100%" }}
            />
            <Edge palette={palette} length={30} />
            <Node
              palette={palette}
              title="entry ring"
              body="may decorate or refuse"
              style={{ width: "100%" }}
            />
            <Edge
              palette={palette}
              length={30}
              label="wrappers, ordered by anchor"
            />
            <div style={{ display: "flex", gap: 8, width: "100%" }}>
              {["breaker", "retry", "timeout", "concurrency"].map((w) => (
                <Chip
                  key={w}
                  palette={palette}
                  style={{ flex: 1, fontSize: "0.95rem", padding: "10px 6px" }}
                >
                  {w}
                </Chip>
              ))}
            </div>
            <Edge palette={palette} length={30} />
            <Node
              palette={palette}
              accent
              title="step loop"
              body="next step runs, returns one of six outcomes; continue loops"
              style={{ width: "100%", minHeight: 110 }}
            />
            <Edge palette={palette} length={30} label="path done" />
            <Node
              palette={palette}
              title="exit ring"
              body="decoration here reaches the caller"
              style={{ width: "100%" }}
            />
            <Edge palette={palette} length={30} />
            <Terminal
              palette={palette}
              tone="accent"
              style={{ alignSelf: "stretch" }}
            >
              completed
            </Terminal>
          </Column>
          {/* right: refusals and failures */}
          <Column style={{ paddingTop: 96, gap: 16 }}>
            <Terminal palette={palette} style={{ alignSelf: "stretch" }}>
              refused · nothing ran
            </Terminal>
            <MonoNote
              palette={palette}
              size="0.85rem"
              style={{ alignSelf: "flex-start", lineHeight: 1.5 }}
            >
              a refusal at admission or entry; on a first delivery an admission
              refusal is told to the error ring
            </MonoNote>
            <div style={{ height: 150 }} />
            <Side
              palette={palette}
              title="a step throws"
              accent
              rows={[
                [
                  "error ring",
                  "every handler hears the failure; a throwing handler is recorded as secondary, the primary is kept",
                ],
                [
                  "defer",
                  "a handler that declared it may park the exchange at the failing step, or at the door for a refusal",
                ],
                [
                  "declined",
                  "before anything is written, when the run was cancelled, the failure has no step, it is inside a fan-out or a nested path, or the same refusal was parked before",
                ],
              ]}
            />
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[
                "DEFER_CANCELLED",
                "DEFER_UNSITED",
                "DEFER_IN_FANOUT",
                "DEFER_IN_PATH",
                "DEFER_REPEATED",
              ].map((c) => (
                <Tag key={c} palette={palette} accent>
                  {c}
                </Tag>
              ))}
            </div>
            <Edge palette={palette} label="otherwise" length={30} />
            <Terminal palette={palette} style={{ alignSelf: "stretch" }}>
              failed
            </Terminal>
          </Column>
        </div>
        <MonoNote palette={palette} size="1rem" style={{ marginTop: "auto" }}>
          a handler or wrapper declares the run kinds it applies to; the breaker
          does not re-arm on a resume, and no first-party wrapper runs on the
          error channel
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
      }}
    >
      <div
        style={{
          width: u * 70,
          height: u * 70,
          border: `${Math.max(2, u * 1.5)}px solid ${palette.muted55}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            width: u * 48,
            height: u * 48,
            border: `${Math.max(2, u * 1.5)}px solid ${palette.muted55}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              width: u * 26,
              height: u * 26,
              backgroundColor: palette.accent,
            }}
          />
        </div>
      </div>
    </div>
  );
}

export const exchangePath: FigureDrawing = {
  id: "exchange-path",
  width: WIDTH,
  height: HEIGHT,
  Figure,
  Motif,
};
