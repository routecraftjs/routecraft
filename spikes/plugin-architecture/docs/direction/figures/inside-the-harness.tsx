import type { ReactNode } from "react";

import { FigureCanvas } from "./primitives.tsx";
import {
  At,
  Band,
  Chip,
  Chips,
  Conclusion,
  Edges,
  Label,
  Note,
  Row,
  Seq,
  Title,
} from "./harness.tsx";
import type { FigurePalette } from "./palette.ts";
import type { FigureDrawing, FigureProps, MotifProps } from "./types.ts";

/**
 * Inside the harness: the "inside every harness" band of `every-way-in`,
 * opened up. Plugins across the top, ours and yours in one row of the same
 * kind; the six sockets they reach the kernel through; the kernel, with what
 * it does for one run, a park, a resume and a sweep; and the ports it calls
 * out through, each provided by a plugin.
 */
const WIDTH = 1600;
const HEIGHT = 1490;

function Plugin({
  palette,
  name,
  does,
  yours = false,
}: {
  palette: FigurePalette;
  name: string;
  does: string;
  yours?: boolean;
}) {
  return (
    <Chip
      palette={palette}
      tone={yours ? "accent" : "plain"}
      sub={does}
      style={{ width: 150 }}
    >
      {name}
    </Chip>
  );
}

function Socket({
  palette,
  name,
  does,
}: {
  palette: FigurePalette;
  name: string;
  does: string;
}) {
  return (
    <Chip
      palette={palette}
      sub={does}
      style={{ width: "100%", letterSpacing: "0.14em" }}
    >
      {name}
    </Chip>
  );
}

function Port({
  palette,
  name,
  by,
}: {
  palette: FigurePalette;
  name: string;
  by: string;
}) {
  return (
    <Chip palette={palette} icon="store" sub={by} style={{ width: 176 }}>
      {name}
    </Chip>
  );
}

function Kernel({ palette }: { palette: FigurePalette }) {
  const k = (items: readonly ReactNode[], lead = false) => (
    <Seq palette={palette} inverse lead={lead} items={items} />
  );
  const yours = (text: string) => (
    <Chip palette={palette} tone="accent">
      {text}
    </Chip>
  );
  const outcome = (text: string) => (
    <Chip
      palette={palette}
      tone="quiet"
      style={{
        color: palette.inverseFg,
        borderColor: `color-mix(in srgb, ${palette.inverseFg} 45%, transparent)`,
      }}
    >
      {text}
    </Chip>
  );
  return (
    <>
      <Row
        palette={palette}
        inverse
        label="Lifecycle"
        divider={false}
        labelWidth={170}
      >
        {k([
          "check identities",
          "resolve every port",
          "order by what each requires",
          "bind",
          "freeze",
          "compile routes",
          "start",
        ])}
        <Note palette={palette} inverse>
          stop runs in reverse; anything that fails on the way names the plugin
          responsible
        </Note>
      </Row>
      <Row
        palette={palette}
        inverse
        label="One run, in a fixed order"
        labelWidth={170}
      >
        {k([
          "admission",
          "entry",
          "breaker",
          "retry",
          yours("your wrapper"),
          "timeout",
          "concurrency",
          <Chip key="loop" palette={palette} tone="accent">
            step loop
          </Chip>,
          "exit",
        ])}
        <Chips gap={7}>
          <Note palette={palette} inverse style={{ marginRight: 6 }}>
            a step returns
          </Note>
          {["continue", "complete", "drop", "branch", "fanOut", "defer"].map(
            (o) => (
              <span key={o}>{outcome(o)}</span>
            ),
          )}
        </Chips>
        <Note palette={palette} inverse>
          what escapes the wrappers reaches the error ring, whose handlers may
          park it at the step that failed; a run ends completed, refused, failed
          or deferred
        </Note>
      </Row>
      <Row palette={palette} inverse label="Which runs" labelWidth={170}>
        <Chips gap={7}>
          {["normal", "resume", "debounce", "errorChannel"].map((o) => (
            <span key={o}>{outcome(o)}</span>
          ))}
          <Note palette={palette} inverse style={{ marginLeft: 8 }}>
            every handler and wrapper declares which kinds it applies to
          </Note>
        </Chips>
      </Row>
      <Row palette={palette} inverse label="Park" labelWidth={170}>
        {k([
          "site and frames",
          "tail hash",
          "encode the exchange",
          "write the record",
          "notify",
          "deferred",
        ])}
        <Note palette={palette} inverse>
          declined before any write when the run was cancelled, the failure has
          no step, it sits inside a fan-out or a nested path, or the same
          refusal was parked before
        </Note>
      </Row>
      <Row palette={palette} inverse label="Resume" labelWidth={170}>
        {k([
          <Chip key="door" palette={palette} tone="accent">
            the door
          </Chip>,
          "deadline",
          "live tail",
          "compare-and-swap",
          "re-admission",
          "the suffix",
          "record the outcome",
        ])}
        <Note palette={palette} inverse>
          the door is the admission ring run over the approval: a refusal
          discloses nothing and spends nothing; one caller wins, a second is
          answered from the record
        </Note>
      </Row>
      <Row palette={palette} inverse label="Sweep" labelWidth={170}>
        {k([
          "release elapsed claims",
          "claim what is due",
          "tell the route",
          "expired",
        ])}
        <Note palette={palette} inverse>
          the deferral plugin decides when; the kernel does the work, the same
          way for any store
        </Note>
      </Row>
    </>
  );
}

function Figure({ palette }: FigureProps) {
  const socketX = (i: number) =>
    150 + 24 + i * ((1300 - 48) / 6) + (1300 - 48) / 12;
  return (
    <FigureCanvas palette={palette} width={WIDTH} height={HEIGHT}>
      <Edges
        palette={palette}
        width={WIDTH}
        height={HEIGHT}
        edges={[
          ...[0, 1, 2, 3, 4, 5].map((i) => ({
            d: `M${socketX(i)},380 V406`,
            kind: "plain" as const,
          })),
          ...[0, 1, 2, 3, 4, 5].map((i) => ({
            d: `M${socketX(i)},536 V564`,
            kind: "plain" as const,
          })),
          { d: "M800,1170 V1202", kind: "plain" },
          { d: "M150,250 H110 V1265 H146", kind: "dashed" },
        ]}
      />
      <At x={84} y={880} rotate>
        <Note palette={palette}>a plugin provides every port</Note>
      </At>
      <At x={814} y={1174}>
        <Note palette={palette}>
          every record transition, through CONTINUATIONS
        </Note>
      </At>

      <Band palette={palette} at={{ x: 150, y: 80, w: 1300, h: 300 }}>
        <Title
          palette={palette}
          inline
          title="Every plugin"
          subtitle="ours and yours, one array, installed the same way"
        />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1px 170px",
            gap: 16,
            marginTop: 8,
          }}
        >
          <div>
            <Row palette={palette} label="Ours" divider={false} labelWidth={64}>
              <Chips gap={8}>
                <Plugin
                  palette={palette}
                  name="operations"
                  does="steps: transform, filter, split"
                />
                <Plugin
                  palette={palette}
                  name="resilience"
                  does="wrappers: retry, timeout, breaker"
                />
                <Plugin
                  palette={palette}
                  name="deferral"
                  does=".defer(); provides CONTINUATIONS"
                />
                <Plugin
                  palette={palette}
                  name="sqlite"
                  does="provides RECORDS"
                />
                <Plugin
                  palette={palette}
                  name="principals"
                  does="provides AUTHORITY"
                />
                <Plugin
                  palette={palette}
                  name="auth"
                  does="the gate; .authorize(), .resumable()"
                />
              </Chips>
            </Row>
            <Row palette={palette} label="Yours" labelWidth={64}>
              <Chips gap={8}>
                <Plugin
                  palette={palette}
                  yours
                  name="your store"
                  does="provides RECORDS; replaces sqlite"
                />
                <Plugin
                  palette={palette}
                  yours
                  name="your wrapper"
                  does="lands between retry and timeout"
                />
                <Plugin
                  palette={palette}
                  yours
                  name="your adapter"
                  does="a step in .from() or .to()"
                />
                <Plugin
                  palette={palette}
                  yours
                  name="your moment"
                  does="a point others can join"
                />
              </Chips>
            </Row>
          </div>
          <div style={{ background: palette.ink15 }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <Label palette={palette} style={{ paddingTop: 12 }}>
              Each one declares
            </Label>
            <Chips gap={6}>
              {[
                "id",
                "requires",
                "provides",
                "replaces",
                "points",
                "facets",
                "methods",
              ].map((t) => (
                <Chip key={t} palette={palette} style={{ padding: "5px 8px" }}>
                  {t}
                </Chip>
              ))}
            </Chips>
            <Note palette={palette} style={{ marginTop: 4 }}>
              then binds in the order those declarations allow
            </Note>
          </div>
        </div>
      </Band>

      <Band palette={palette} at={{ x: 150, y: 408, w: 1300, h: 128 }}>
        <Title
          palette={palette}
          inline
          size="1.7rem"
          title="Six sockets"
          subtitle="four you build with, a moment you declare, verbs you call; nothing else reaches the kernel"
        />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(6, 1fr)",
            gap: 10,
            marginTop: 14,
          }}
        >
          <Socket palette={palette} name="PORT" does="require · provide" />
          <Socket
            palette={palette}
            name="CONTRIBUTION"
            does="handler · wrapper, by anchor"
          />
          <Socket
            palette={palette}
            name="STEP"
            does="returns one of six outcomes"
          />
          <Socket
            palette={palette}
            name="FACET"
            does="ex.<namespace>, derived"
          />
          <Socket
            palette={palette}
            name="POINT"
            does="a moment handlers join"
          />
          <Socket
            palette={palette}
            name="EXECUTION"
            does="deliver · resume · sweep"
          />
        </div>
      </Band>

      <Band palette={palette} inverse at={{ x: 150, y: 566, w: 1300, h: 604 }}>
        <Title
          palette={palette}
          inverse
          inline
          title="The kernel"
          subtitle="decides when things run and how a parked exchange comes back; runs nothing of its own"
        />
        <div style={{ marginTop: 10 }}>
          <Kernel palette={palette} />
        </div>
      </Band>

      <Band palette={palette} at={{ x: 150, y: 1204, w: 1300, h: 122 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "300px 1fr",
            gap: 20,
            alignItems: "start",
          }}
        >
          <Title
            palette={palette}
            size="1.7rem"
            title="Ports it calls out through"
            subtitle="each one provided by whichever plugin is installed for it"
          />
          <Chips gap={8}>
            <Port
              palette={palette}
              name="CONTINUATIONS"
              by="deferral, over RECORDS"
            />
            <Port palette={palette} name="RECORDS" by="sqlite, or your store" />
            <Port palette={palette} name="AUTHORITY" by="principals" />
            <Port palette={palette} name="ENFORCEMENT" by="auth" />
            <Port
              palette={palette}
              name="RESILIENCE"
              by="owns RETRY, TIMEOUT"
            />
          </Chips>
        </div>
      </Band>

      <Conclusion
        palette={palette}
        y={1370}
        width={WIDTH}
        plain="One kernel, every feature a plugin,"
        accent="the same sockets for ours and yours."
      />
    </FigureCanvas>
  );
}

/** Motif: a band of plugins over a strip of sockets over the inverted kernel. */
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
      <div style={{ display: "flex", gap: u * 3 }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            style={{
              width: u * 11,
              height: u * 10,
              border: `${Math.max(2, u * 1.3)}px solid ${i > 2 ? palette.accent : palette.muted55}`,
            }}
          />
        ))}
      </div>
      <div
        style={{
          width: u * 67,
          height: u * 6,
          backgroundColor: palette.muted25,
        }}
      />
      <div
        style={{ width: u * 67, height: u * 30, backgroundColor: palette.fg }}
      />
    </div>
  );
}

export const insideTheHarness: FigureDrawing = {
  id: "inside-the-harness",
  width: WIDTH,
  height: HEIGHT,
  Figure,
  Motif,
};
