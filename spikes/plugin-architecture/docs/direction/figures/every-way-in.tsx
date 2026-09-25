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
  SERIF,
  Title,
} from "./harness.tsx";
import type { FigureDrawing, FigureProps, MotifProps } from "./types.ts";

/**
 * Every way in: the harness as a consumer meets it, from outside. Who calls,
 * the local and the team harness, what is inside every harness, and the
 * systems it reaches with which credentials. The internals of the "inside
 * every harness" band are the subject of `inside-the-harness`.
 */
const WIDTH = 1600;
const HEIGHT = 1500;

function Figure({ palette }: FigureProps) {
  const lock = (text: string) => (
    <Chip palette={palette} icon="lock" style={{ width: "100%" }}>
      {text}
    </Chip>
  );
  const store = (text: string) => (
    <Chip palette={palette} icon="store" style={{ width: "100%" }}>
      {text}
    </Chip>
  );
  const grid = (cols: string) => ({
    display: "grid",
    gridTemplateColumns: cols,
    gap: 9,
  });
  return (
    <FigureCanvas palette={palette} width={WIDTH} height={HEIGHT}>
      <Edges
        palette={palette}
        width={WIDTH}
        height={HEIGHT}
        edges={[
          { d: "M435,230 V306", kind: "plain" },
          { d: "M1165,230 V306", kind: "plain" },
          { d: "M1350,310 V234", kind: "plain" },
          { d: "M737,352 H876", kind: "plain" },
          { d: "M878,374 H739", kind: "dashed" },
          { d: "M751,452 H739", kind: "plain" },
          { d: "M865,452 H876", kind: "plain" },
          { d: "M720,520 L800,580 L880,520", kind: "faint", head: false },
          { d: "M150,415 H110 V1195 H146", kind: "dashed" },
          { d: "M1450,415 H1490 V1195 H1454", kind: "accent" },
        ]}
      />

      <Band palette={palette} at={{ x: 150, y: 80, w: 1300, h: 150 }}>
        <Title
          palette={palette}
          title="Every way in"
          subtitle={
            <span style={{ display: "block", width: 190 }}>
              people in their editor, any agent over MCP, the CLI, HTTP, and
              triggers that need nobody
            </span>
          }
        />
      </Band>
      <At x={384} y={102}>
        <Label palette={palette}>When someone asks</Label>
      </At>
      <div
        style={{
          position: "absolute",
          left: 384,
          top: 122,
          width: 355,
          ...grid("200px 146px"),
        }}
      >
        {lock("your editor, over ACP")}
        {lock("any MCP client")}
        {lock("the CLI: run, exec")}
        {lock("HTTP")}
      </div>
      <At x={767} y={102}>
        <Label palette={palette}>When nobody asks</Label>
      </At>
      <div
        style={{
          position: "absolute",
          left: 767,
          top: 122,
          width: 460,
          ...grid("134px 118px 190px"),
        }}
      >
        {["cron and timers", "webhooks", "mail arriving"].map((t) => (
          <Chip key={t} palette={palette} style={{ width: "100%" }}>
            {t}
          </Chip>
        ))}
        {["runtime events", "files landing", "a parked task resuming"].map(
          (t) => (
            <Chip key={t} palette={palette} style={{ width: "100%" }}>
              {t}
            </Chip>
          ),
        )}
      </div>
      <div
        style={{
          position: "absolute",
          left: 1270,
          top: 117,
          width: 160,
          height: 75,
          border: `1px solid ${palette.ink25}`,
          background: palette.paper,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 2,
        }}
      >
        <span style={{ fontFamily: SERIF, fontSize: "1.7rem", lineHeight: 1 }}>
          you
        </span>
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "0.75rem",
            color: palette.ink60,
          }}
        >
          approve by mail or chat
        </span>
      </div>
      <At x={1180} y={252} w={158} align="right">
        <Note palette={palette}>asks you when it needs a decision</Note>
      </At>

      <At x={166} y={255}>
        <Note palette={palette}>one per person</Note>
      </At>
      {[16, 8].map((o) => (
        <div
          key={o}
          style={{
            position: "absolute",
            left: 150 + o,
            top: 310 - o,
            width: 570,
            height: 210,
            border: `1px dashed ${palette.ink40}`,
          }}
        />
      ))}
      <Band palette={palette} at={{ x: 150, y: 310, w: 570, h: 210 }}>
        <Title
          palette={palette}
          title="Local harness"
          subtitle="on your laptop, personal credentials"
        />
        <Chips style={{ marginTop: 26 }}>
          <Chip palette={palette}>team capabilities, over a remote</Chip>
          <Chip palette={palette}>your own capabilities</Chip>
          <Chip palette={palette}>an agent in your editor</Chip>
          <Chip palette={palette}>the terminal UI</Chip>
        </Chips>
      </Band>

      <At x={743} y={327}>
        <Note palette={palette}>promote when proven</Note>
      </At>
      <At x={788} y={381}>
        <Note palette={palette}>remote</Note>
      </At>
      <div
        style={{
          position: "absolute",
          left: 751,
          top: 422,
          width: 114,
          padding: "6px 4px",
          border: `1px solid ${palette.ink25}`,
          background: palette.paper,
          textAlign: "center",
        }}
      >
        <Note palette={palette}>
          capabilities, skills, agents, as npm packages
        </Note>
      </div>

      <Band palette={palette} inverse at={{ x: 880, y: 310, w: 570, h: 210 }}>
        <Title
          palette={palette}
          inverse
          title="Team harness"
          subtitle="always on, service credentials, every call on record"
        />
        <Chips style={{ marginTop: 26 }}>
          {[
            "health and readiness",
            "the ops API",
            "telemetry on record",
            "work that survives restarts",
            "conversations that resume",
          ].map((t) => (
            <Chip
              key={t}
              palette={palette}
              style={{ border: `1px solid ${palette.paper}` }}
            >
              {t}
            </Chip>
          ))}
        </Chips>
      </Band>

      <Band palette={palette} at={{ x: 150, y: 580, w: 1300, h: 500 }}>
        <Title
          palette={palette}
          inline
          title="Inside every harness"
          subtitle="the same runtime on a laptop and on a server"
        />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1px 160px",
            gap: 16,
            marginTop: 10,
          }}
        >
          <div>
            <Row
              palette={palette}
              label="The gate, in a fixed order"
              divider={false}
            >
              <Seq
                palette={palette}
                items={[
                  "authenticate",
                  "authorise by scope",
                  "validate input",
                  "throttle",
                  "circuit breaker",
                ]}
              />
              <Note palette={palette}>JWT, JWKS, API keys, OAuth</Note>
              <Seq
                palette={palette}
                lead
                items={["retry", "timeout", "concurrency", "cache"]}
              />
            </Row>
            <Row palette={palette} label="Agents and skills">
              <Chips>
                {[
                  "named agents",
                  "any model",
                  "skills",
                  "tools are capabilities",
                  "sessions",
                  "defer and resume",
                  "asks you for decisions",
                ].map((t) => (
                  <Chip key={t} palette={palette}>
                    {t}
                  </Chip>
                ))}
              </Chips>
            </Row>
            <Row palette={palette} label="Capabilities">
              <Chips>
                <Chip palette={palette}>craft() defines one</Chip>
                <span
                  style={{
                    width: 1,
                    height: 24,
                    background: palette.ink25,
                    margin: "0 8px",
                  }}
                />
                {[
                  "transform",
                  "enrich",
                  "filter",
                  "choice",
                  "split",
                  "aggregate",
                  "dedupe",
                  "multicast",
                  "dispatch",
                  "defer",
                ].map((t) => (
                  <Chip key={t} palette={palette}>
                    {t}
                  </Chip>
                ))}
              </Chips>
            </Row>
            <Row palette={palette} label="Adapters">
              <Chips>
                {[
                  "HTTP",
                  "mail",
                  "files and folders",
                  "CSV, JSON, XML, HTML",
                  "a sandboxed shell",
                  "a browser",
                  "other MCP servers",
                  "contacts",
                  "models and embeddings",
                ].map((t) => (
                  <Chip key={t} palette={palette}>
                    {t}
                  </Chip>
                ))}
              </Chips>
            </Row>
          </div>
          <div style={{ background: palette.ink15 }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <Label palette={palette} style={{ paddingTop: 14 }}>
              Runtime
            </Label>
            {[
              "event bus",
              "telemetry store",
              "deferral store",
              "session store",
            ].map((t) => (
              <Chip
                key={t}
                palette={palette}
                style={{ justifyContent: "center" }}
              >
                {t}
              </Chip>
            ))}
          </div>
        </div>
      </Band>

      <Band palette={palette} at={{ x: 150, y: 1130, w: 1300, h: 130 }}>
        <Title
          palette={palette}
          title="Your systems"
          subtitle="as they are, where they are"
          style={{ marginTop: 12 }}
        />
      </Band>
      <div
        style={{
          position: "absolute",
          left: 384,
          top: 1154,
          width: 632,
          ...grid("146px 170px 146px 146px"),
        }}
      >
        {store("CRM")}
        {store("ERP")}
        {store("HR and payroll")}
        {store("ticketing")}
        {store("knowledge base")}
        {store("mail and calendar")}
        {store("chat")}
        {store("source control")}
      </div>
      <div
        style={{
          position: "absolute",
          left: 1200,
          top: 1165,
          width: 1,
          height: 60,
          background: palette.ink15,
        }}
      />
      <At x={1225} y={1164}>
        <Label palette={palette}>Model providers</Label>
      </At>
      <At x={1225} y={1186}>
        <Chip palette={palette}>any provider you approve</Chip>
      </At>

      <At x={84} y={880} rotate>
        <Note palette={palette}>personal credentials</Note>
      </At>
      <At x={1500} y={880} rotate>
        <Note palette={palette} accent>
          service credentials
        </Note>
      </At>

      <Conclusion
        palette={palette}
        y={1368}
        width={WIDTH}
        plain="One runtime, every way in,"
        accent="the same capabilities everywhere."
      />
    </FigureCanvas>
  );
}

/** Motif: a band on top, two harnesses beneath it, one inverted, and a band under both. */
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
        gap: u * 5,
      }}
    >
      <div
        style={{
          width: u * 70,
          height: u * 12,
          backgroundColor: palette.muted25,
        }}
      />
      <div style={{ display: "flex", gap: u * 6 }}>
        <div
          style={{
            width: u * 32,
            height: u * 18,
            backgroundColor: palette.muted25,
          }}
        />
        <div
          style={{ width: u * 32, height: u * 18, backgroundColor: palette.fg }}
        />
      </div>
      <div
        style={{
          width: u * 70,
          height: u * 24,
          backgroundColor: palette.muted25,
        }}
      />
    </div>
  );
}

export const everyWayIn: FigureDrawing = {
  id: "every-way-in",
  width: WIDTH,
  height: HEIGHT,
  Figure,
  Motif,
};
