import { FigureCanvas } from "./primitives.tsx";
import {
  Band,
  Chip,
  Chips,
  Conclusion,
  Note,
  Row,
  Seq,
  Title,
} from "./harness.tsx";
import type { FigureDrawing, FigureProps, MotifProps } from "./types.ts";

/** A parked exchange over its life: one waiting record, a resume won once, a notification leased. */
const WIDTH = 1600;
const HEIGHT = 860;

function Figure({ palette }: FigureProps) {
  return (
    <FigureCanvas palette={palette} width={WIDTH} height={HEIGHT}>
      <Band palette={palette} at={{ x: 150, y: 80, w: 1300, h: 150 }}>
        <Title
          palette={palette}
          inline
          title="Waiting"
          subtitle="written with its index in one transaction when the exchange parked"
        />
        <Chips style={{ marginTop: 18 }}>
          <Chip palette={palette} sub="a resume may take it">
            unclaimed
          </Chip>
          <Note palette={palette}>⇄</Note>
          <Chip
            palette={palette}
            sub="a notification holds a lease; a resume is excluded"
          >
            claimed
          </Chip>
          <Note palette={palette} style={{ marginLeft: 10 }}>
            the record stays waiting either way; only the transitions below
            leave it
          </Note>
        </Chips>
      </Band>

      <Band palette={palette} inverse at={{ x: 150, y: 256, w: 640, h: 380 }}>
        <Title
          palette={palette}
          inverse
          title="A resume is won once"
          subtitle="a compare-and-swap out of unclaimed"
        />
        <div style={{ marginTop: 12 }}>
          <Row
            palette={palette}
            inverse
            label="The winner"
            divider={false}
            labelWidth={92}
          >
            <Seq
              palette={palette}
              inverse
              items={[
                "markResumed",
                <Chip key="r" palette={palette} tone="accent">
                  resumed
                </Chip>,
                "suffix runs",
                "outcome recorded",
              ]}
            />
            <Note palette={palette} inverse>
              the record says who resumed it
            </Note>
          </Row>
          <Row palette={palette} inverse label="A second" labelWidth={92}>
            <Note
              palette={palette}
              inverse
              style={{ fontSize: "0.8rem", paddingTop: 7 }}
            >
              answered from the record with how the first one ended; nothing
              runs twice
            </Note>
          </Row>
          <Row palette={palette} inverse label="A crash" labelWidth={92}>
            <Note
              palette={palette}
              inverse
              style={{ fontSize: "0.8rem", paddingTop: 7 }}
            >
              a winner that dies before recording its outcome is reported at the
              next start, and never re-run: the steps after the park may have
              half happened
            </Note>
          </Row>
        </div>
      </Band>

      <Band palette={palette} at={{ x: 810, y: 256, w: 640, h: 380 }}>
        <Title
          palette={palette}
          title="A notification is leased"
          subtitle="an expiry or a denial, delivered at least once"
        />
        <div style={{ marginTop: 12 }}>
          <Row palette={palette} label="Due" divider={false} labelWidth={92}>
            <Seq
              palette={palette}
              items={[
                "claimExpiry",
                "route told",
                "markExpired",
                <Chip key="e" palette={palette} tone="strong">
                  expired
                </Chip>,
              ]}
            />
          </Row>
          <Row palette={palette} label="Changed" labelWidth={92}>
            <Seq
              palette={palette}
              items={[
                "claim",
                "route told",
                "markDenied",
                <Chip key="d" palette={palette} tone="strong">
                  denied
                </Chip>,
              ]}
            />
            <Note palette={palette}>so is a park whose notify failed</Note>
          </Row>
          <Row palette={palette} label="A crash" labelWidth={92}>
            <Seq
              palette={palette}
              items={["lease elapses", "releaseClaims", "nag re-sent"]}
            />
          </Row>
        </div>
      </Band>

      <Band
        palette={palette}
        at={{ x: 150, y: 662, w: 1300, h: 62 }}
        style={{ padding: "12px 24px" }}
      >
        <Chips>
          <Note palette={palette}>past retention</Note>
          <Seq
            palette={palette}
            items={["resumed, expired or denied", "purgeSettled", "gone"]}
          />
        </Chips>
      </Band>

      <Conclusion
        palette={palette}
        y={760}
        width={WIDTH}
        plain="Re-sending a nag is safe;"
        accent="re-running half a payment is not."
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
        style={{ width: u * 24, height: u * 24, backgroundColor: palette.fg }}
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
