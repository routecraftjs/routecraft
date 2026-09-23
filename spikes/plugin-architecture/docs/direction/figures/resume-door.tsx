import { Fragment } from "react";

import { Eyebrow, FigureCanvas, MonoNote, Subhead } from "./primitives.tsx";
import { Tag } from "./flow.tsx";
import type { FigureDrawing, FigureProps, MotifProps } from "./types.ts";

const WIDTH = 1600;
const HEIGHT = 1480;

type Lane = 0 | 1 | 2;

interface Beat {
  n: number;
  lane: Lane;
  title: string;
  body: string;
  tag?: string;
  accent?: boolean;
}

const BEATS: Beat[] = [
  {
    n: 1,
    lane: 0,
    title: "resume(id, payload, signal)",
    body: "the approval arrives with whatever identity the ingress carries",
  },
  {
    n: 2,
    lane: 2,
    title: "read the record",
    body: "its state is not yet disclosed to the caller",
  },
  {
    n: 3,
    lane: 1,
    title: "the door",
    body: "authorize sees the approver, the parked headers, the payload and the record without its body; elevate may re-mint the parked identity within what was recorded as refused. false, a throw or an abort is one refusal",
    tag: "refused: nothing disclosed, nothing spent",
    accent: true,
  },
  {
    n: 4,
    lane: 1,
    title: "deadline, then the live tail",
    body: "an expired record is settled as expired; a route whose remaining steps changed since the park is denied and the route is told",
    tag: "EXPIRED · PLAN_MISMATCH",
  },
  {
    n: 5,
    lane: 2,
    title: "markResumed",
    body: "compare-and-swap out of unclaimed; the record now names who resumed it",
    tag: "lost: the other caller won",
  },
  {
    n: 6,
    lane: 1,
    title: "re-admission, if parked at the door",
    body: "the gate that refused is asked again of what the continuation carries: the parked identity, or the door’s lend",
    tag: "refused again: a failure the error ring hears",
  },
  {
    n: 7,
    lane: 1,
    title: "run the suffix",
    body: "from the step that parked, as the parked identity restored, readable and not a credential; nothing else from the ingress reaches it",
  },
  {
    n: 8,
    lane: 2,
    title: "recordOutcome",
    body: "completed, failed, or parked again further on",
  },
  {
    n: 9,
    lane: 0,
    title: "resume(id) again",
    body: "the door first, then answered with the recorded outcome; nothing runs twice",
    tag: "duplicate",
  },
];

const LANES = ["the approver", "the runtime", "the store"];

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
          The door of a resume
        </Eyebrow>
        <Subhead palette={palette} size="1.9rem">
          Decided before anything is disclosed or spent, applied after the
          claim.
        </Subhead>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "48px 1fr 1fr 1fr",
            columnGap: 22,
            rowGap: 10,
            marginTop: 6,
            alignItems: "stretch",
          }}
        >
          <span />
          {LANES.map((l, i) => (
            <div
              key={l}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.95rem",
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                color: i === 1 ? palette.accent : palette.ink55,
                borderBottom: `1px solid ${palette.ink15}`,
                paddingBottom: 10,
              }}
            >
              {l}
            </div>
          ))}
          {BEATS.map((b) => (
            <Fragment key={b.n}>
              <span
                style={{
                  fontFamily: "var(--font-editorial)",
                  fontStyle: "italic",
                  fontSize: "1.6rem",
                  color: palette.accent,
                  lineHeight: 1,
                }}
              >
                {b.n}
              </span>
              {[0, 1, 2].map((lane) =>
                lane === b.lane ? (
                  <div
                    key={lane}
                    style={{
                      border: `${b.accent ? 2 : 1}px solid ${b.accent ? palette.accent : palette.ink35}`,
                      padding: "12px 16px",
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      background: palette.paper,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "1.02rem",
                        color: b.accent ? palette.accent : palette.ink,
                      }}
                    >
                      {b.title}
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--font-sans)",
                        fontSize: "0.93rem",
                        lineHeight: 1.4,
                        color: palette.ink60,
                      }}
                    >
                      {b.body}
                    </span>
                    {b.tag ? (
                      <Tag
                        palette={palette}
                        accent={b.accent}
                        style={{ alignSelf: "flex-start", marginTop: 4 }}
                      >
                        {b.tag}
                      </Tag>
                    ) : null}
                  </div>
                ) : (
                  <div
                    key={lane}
                    style={{
                      borderLeft: `1px dashed ${palette.ink15}`,
                      marginLeft: "50%",
                    }}
                  />
                ),
              )}
            </Fragment>
          ))}
        </div>
        <MonoNote
          palette={palette}
          size="1rem"
          style={{ marginTop: "auto", lineHeight: 1.6 }}
        >
          intended, not yet demonstrated: the door resolved independently of the
          deferred route, and a cancelled or hanging notification denying the
          record
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
        gap: u * 6,
      }}
    >
      <div
        style={{
          width: u * 14,
          height: u * 14,
          borderRadius: "50%",
          border: `${s}px solid ${palette.muted55}`,
        }}
      />
      <div
        style={{ width: u * 10, height: s, backgroundColor: palette.muted40 }}
      />
      <div
        style={{
          width: u * 22,
          height: u * 50,
          border: `${s * 1.5}px solid ${palette.accent}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          paddingRight: u * 4,
        }}
      >
        <div
          style={{
            width: u * 3,
            height: u * 3,
            borderRadius: "50%",
            backgroundColor: palette.accent,
          }}
        />
      </div>
      <div
        style={{ width: u * 10, height: s, backgroundColor: palette.muted40 }}
      />
      <div
        style={{ width: u * 20, height: u * 24, backgroundColor: palette.fg }}
      />
    </div>
  );
}

export const resumeDoor: FigureDrawing = {
  id: "resume-door",
  width: WIDTH,
  height: HEIGHT,
  Figure,
  Motif,
};
