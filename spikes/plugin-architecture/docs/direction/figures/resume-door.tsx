import { FigureCanvas } from "./primitives.tsx";
import {
  Band,
  Chip,
  Chips,
  Conclusion,
  Label,
  Note,
  SERIF,
  Title,
} from "./harness.tsx";
import type { FigurePalette } from "./palette.ts";
import type { FigureDrawing, FigureProps, MotifProps } from "./types.ts";

/** The door of a resume, beat by beat, with who acts at each beat. */
const WIDTH = 1600;
const HEIGHT = 1000;

interface Beat {
  who: "approver" | "runtime" | "store";
  step: string;
  note: string;
  tag?: string;
  door?: boolean;
}

const BEATS: Beat[] = [
  {
    who: "approver",
    step: "resume(id, payload, signal)",
    note: "the approval arrives with whatever identity the ingress carries",
  },
  {
    who: "store",
    step: "read the record",
    note: "its state is not yet disclosed to the caller",
  },
  {
    who: "runtime",
    step: "the door",
    note: "the admission ring over the approval: authorize sees the approver, the parked headers, the payload and the record without its body; elevate may re-mint the parked identity within what was refused. False, a throw or an abort is one refusal",
    tag: "refused: nothing disclosed, nothing spent",
    door: true,
  },
  {
    who: "runtime",
    step: "deadline, then the live tail",
    note: "an overdue record is settled as expired; a route whose remaining steps changed is denied, and told",
    tag: "EXPIRED · PLAN_MISMATCH",
  },
  {
    who: "store",
    step: "markResumed",
    note: "a compare-and-swap out of unclaimed; the record now names who resumed it",
    tag: "lost: the other caller won",
  },
  {
    who: "runtime",
    step: "re-admission, if parked at the door",
    note: "the gate that refused is asked again of what the continuation carries: the parked identity, or the door's lend",
    tag: "refused again: a failure the error ring hears",
  },
  {
    who: "runtime",
    step: "run the suffix",
    note: "from the step that parked, as the parked identity restored, readable and not a credential",
  },
  {
    who: "store",
    step: "recordOutcome",
    note: "completed, failed, or parked again further on",
  },
  {
    who: "approver",
    step: "resume(id) again",
    note: "the door first, then answered with the recorded outcome; nothing runs twice",
    tag: "duplicate",
  },
];

const WHO: Record<Beat["who"], string> = {
  approver: "the approver",
  runtime: "the runtime",
  store: "the store",
};

function BeatRow({
  palette,
  beat,
  n,
}: {
  palette: FigurePalette;
  beat: Beat;
  n: number;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "44px 150px 300px 1fr",
        gap: 16,
        alignItems: "start",
        padding: "11px 0",
        borderTop: n > 1 ? `1px solid ${palette.ink15}` : undefined,
      }}
    >
      <span
        style={{
          fontFamily: SERIF,
          fontStyle: "italic",
          fontSize: "1.6rem",
          lineHeight: 1,
          color: palette.accent,
        }}
      >
        {n}
      </span>
      <Label
        palette={palette}
        accent={beat.who === "runtime"}
        style={{ paddingTop: 8 }}
      >
        {WHO[beat.who]}
      </Label>
      <div>
        <Chip palette={palette} tone={beat.door ? "strong" : "plain"}>
          {beat.step}
        </Chip>
      </div>
      <Chips gap={8}>
        <Note palette={palette} style={{ fontSize: "0.78rem", paddingTop: 6 }}>
          {beat.note}
        </Note>
        {beat.tag ? (
          <Chip
            palette={palette}
            tone={beat.door ? "accent" : "quiet"}
            style={{ fontSize: "0.72rem", padding: "4px 8px" }}
          >
            {beat.tag}
          </Chip>
        ) : null}
      </Chips>
    </div>
  );
}

function Figure({ palette }: FigureProps) {
  return (
    <FigureCanvas palette={palette} width={WIDTH} height={HEIGHT}>
      <Band palette={palette} at={{ x: 150, y: 80, w: 1300, h: 760 }}>
        <Title
          palette={palette}
          inline
          title="The door of a resume"
          subtitle="nine beats, three actors"
        />
        <div style={{ marginTop: 14 }}>
          {BEATS.map((b, i) => (
            <BeatRow key={i} palette={palette} beat={b} n={i + 1} />
          ))}
        </div>
      </Band>
      <Conclusion
        palette={palette}
        y={880}
        width={WIDTH}
        plain="Decided before anything is disclosed,"
        accent="applied after the claim."
      />
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
        style={{ width: u * 22, height: u * 50, backgroundColor: palette.fg }}
      />
      <div
        style={{ width: u * 10, height: s, backgroundColor: palette.muted40 }}
      />
      <div
        style={{
          width: u * 20,
          height: u * 24,
          border: `${s * 1.5}px solid ${palette.accent}`,
        }}
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
