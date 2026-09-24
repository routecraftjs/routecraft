import { Fragment } from "react";

import { Eyebrow, FigureCanvas, MonoNote, Subhead } from "./primitives.tsx";
import { Edge, Node, Tag, Terminal } from "./flow.tsx";
import type { FigureDrawing, FigureProps, MotifProps } from "./types.ts";

const WIDTH = 1100;
const HEIGHT = 1340;

interface Stage {
  title: string;
  body: string;
  refuses?: string[];
  accent?: boolean;
}

const STAGES: Stage[] = [
  { title: "plugin descriptors", body: "an ordinary array, in any order" },
  {
    title: "validate identity",
    body: "one id, one namespace, one token per port name",
    refuses: [
      "DUPLICATE_ID",
      "DUPLICATE_NAMESPACE",
      "PORT_IDENTITY",
      "INVALID_REPLACEMENT",
      "DUPLICATE_POINT",
    ],
  },
  {
    title: "resolve every port",
    body: "one provider, or one plus a declared replacement",
    refuses: ["MISSING_PORT", "DUPLICATE_PROVIDER"],
  },
  {
    title: "order by dependency",
    body: "a topological sort over require and provide",
    refuses: ["CYCLE"],
  },
  {
    title: "bind() each plugin",
    body: "require · provide · contribute · observe",
    refuses: ["UNKNOWN_POINT", "UNPROVIDED_PORT"],
  },
  { title: "FREEZE", body: "no contribution after this line", accent: true },
  {
    title: "order contributions",
    body: "by anchor and constraint; the same sort as above",
  },
  {
    title: "compile routes",
    body: "wrapper state binds once per route; an ask names the port it requires",
    refuses: ["ROUTE_REQUIRES", "DUPLICATE_ROUTE"],
  },
  {
    title: "start() each plugin",
    body: "sources subscribe first; the deferral plugin runs its boot scan here",
    refuses: ["rolled back on failure"],
  },
];

function Figure({ palette }: FigureProps) {
  return (
    <FigureCanvas palette={palette} width={WIDTH} height={HEIGHT} markTop={54}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          padding: "64px 80px 56px",
          gap: 18,
        }}
      >
        <Eyebrow palette={palette} accent>
          Installation
        </Eyebrow>
        <Subhead palette={palette} size="1.9rem">
          From descriptors to a running application. Everything that can fail
          names the plugin responsible.
        </Subhead>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "560px 1fr",
            columnGap: 28,
            marginTop: 10,
          }}
        >
          {STAGES.map((s, i) => (
            <Fragment key={s.title}>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                }}
              >
                {i > 0 ? <Edge palette={palette} length={26} /> : null}
                {s.accent ? (
                  <Terminal
                    palette={palette}
                    tone="inverse"
                    style={{
                      width: "100%",
                      borderRadius: 0,
                      fontSize: "1.05rem",
                    }}
                  >
                    {s.title} · {s.body}
                  </Terminal>
                ) : (
                  <Node
                    palette={palette}
                    title={s.title}
                    body={s.body}
                    style={{ width: "100%" }}
                  />
                )}
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-end",
                  paddingBottom: s.accent ? 12 : 16,
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                {s.refuses?.map((r) => (
                  <Tag key={r} palette={palette} accent={r === r.toUpperCase()}>
                    {r}
                  </Tag>
                ))}
              </div>
            </Fragment>
          ))}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
            }}
          >
            <Edge palette={palette} length={26} />
            <Terminal palette={palette} tone="accent" style={{ width: "100%" }}>
              running
            </Terminal>
            <Edge palette={palette} length={26} label="stop()" />
            <Node
              palette={palette}
              title="stop in reverse"
              body="consumers before providers; failures aggregated, none skipped"
              style={{ width: "100%" }}
            />
          </div>
          <span />
        </div>
        <MonoNote palette={palette} size="1rem" style={{ marginTop: "auto" }}>
          accent tags are fault codes; the plugin named in each is the one at
          fault
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
        gap: u * 4,
      }}
    >
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            width: u * 56,
            height: u * 11,
            border: `${Math.max(2, u * 1.5)}px solid ${palette.muted55}`,
          }}
        />
      ))}
      <div
        style={{ width: u * 56, height: u * 5, backgroundColor: palette.fg }}
      />
      {[0, 1].map((i) => (
        <div
          key={i}
          style={{
            width: u * 56,
            height: u * 11,
            border: `${Math.max(2, u * 1.5)}px solid ${palette.accent}`,
          }}
        />
      ))}
    </div>
  );
}

export const installation: FigureDrawing = {
  id: "installation",
  width: WIDTH,
  height: HEIGHT,
  Figure,
  Motif,
};
