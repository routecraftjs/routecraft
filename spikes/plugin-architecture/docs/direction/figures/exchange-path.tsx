import { FigureCanvas } from "./primitives.tsx";
import {
  Band,
  Chip,
  Chips,
  Conclusion,
  Fault,
  Inset,
  Label,
  Note,
  Row,
  Seq,
  Title,
} from "./harness.tsx";
import type { FigureDrawing, FigureProps, MotifProps } from "./types.ts";

/** One exchange through a route: the fixed order, the six outcomes, and every way a run can leave. */
const WIDTH = 1600;
const HEIGHT = 860;

function Figure({ palette }: FigureProps) {
  return (
    <FigureCanvas palette={palette} width={WIDTH} height={HEIGHT}>
      <Band palette={palette} at={{ x: 150, y: 80, w: 1300, h: 620 }}>
        <Title
          palette={palette}
          inline
          title="One run, in a fixed order"
          subtitle="rings around a step loop; a step returns what happens next"
        />
        <Inset palette={palette} inverse style={{ marginTop: 18 }}>
          <Seq
            palette={palette}
            inverse
            items={[
              "a run",
              "admission",
              "entry",
              "breaker",
              "retry",
              "timeout",
              "concurrency",
              <Chip key="loop" palette={palette} tone="accent">
                step loop
              </Chip>,
              "exit",
              <Chip key="done" palette={palette} tone="accent">
                completed
              </Chip>,
            ]}
          />
          <Note
            palette={palette}
            inverse
            style={{ display: "block", marginTop: 10 }}
          >
            handlers at admission and entry may decorate or refuse; wrappers
            land by anchor, so yours can sit between retry and timeout; exit
            runs only over exchanges that completed
          </Note>
        </Inset>
        <div style={{ marginTop: 6 }}>
          <Row
            palette={palette}
            label="Six outcomes"
            divider={false}
            labelWidth={170}
          >
            <Chips>
              <Chip palette={palette} sub="the next step">
                continue
              </Chip>
              <Chip palette={palette} sub="stop here; what pends is done">
                complete
              </Chip>
              <Chip palette={palette} sub="stop; nothing reaches the caller">
                drop
              </Chip>
              <Chip palette={palette} sub="splice children ahead of what pends">
                branch
              </Chip>
              <Chip palette={palette} sub="every child; none may park">
                fanOut
              </Chip>
              <Chip
                palette={palette}
                tone="accent"
                sub="persist a continuation and halt"
              >
                defer
              </Chip>
            </Chips>
            <Note palette={palette}>
              any step may return any of them, yours included; defer ends the
              run as deferred and the process may exit
            </Note>
          </Row>
          <Row palette={palette} label="Refused" labelWidth={170}>
            <Chips>
              <Chip palette={palette} tone="strong">
                refused · nothing ran
              </Chip>
              <Note palette={palette}>
                an admission refusal on a first delivery is also told to the
                error ring, so a route can park it; an entry refusal is not
              </Note>
            </Chips>
          </Row>
          <Row palette={palette} label="A step throws" labelWidth={170}>
            <Seq
              palette={palette}
              items={[
                "the wrappers retry what they can",
                "what escapes reaches the error ring",
                <Chip key="park" palette={palette} tone="accent">
                  a handler may park it at the step that failed
                </Chip>,
              ]}
            />
            <Chips gap={6}>
              <Label palette={palette} style={{ marginRight: 6 }}>
                Declined before any write
              </Label>
              {[
                "DEFER_CANCELLED",
                "DEFER_UNSITED",
                "DEFER_IN_FANOUT",
                "DEFER_IN_PATH",
                "DEFER_REPEATED",
              ].map((f) => (
                <Fault key={f} palette={palette}>
                  {f}
                </Fault>
              ))}
            </Chips>
            <Chips>
              <Chip palette={palette} tone="strong">
                failed
              </Chip>
              <Note palette={palette}>
                otherwise: the primary error, with any handler that threw
                recorded beside it
              </Note>
            </Chips>
          </Row>
          <Row palette={palette} label="Which runs" labelWidth={170}>
            <Chips>
              {["normal", "resume", "debounce", "errorChannel"].map((t) => (
                <Chip key={t} palette={palette} tone="quiet">
                  {t}
                </Chip>
              ))}
              <Note palette={palette}>
                every handler and wrapper declares which it applies to; the
                breaker does not re-arm on a resume, and no first-party wrapper
                runs on the error channel
              </Note>
            </Chips>
          </Row>
        </div>
      </Band>
      <Conclusion
        palette={palette}
        y={740}
        width={WIDTH}
        plain="One order for every run,"
        accent="and a step that says what happens next."
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
