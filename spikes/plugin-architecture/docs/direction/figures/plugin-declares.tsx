import { FigureCanvas } from "./primitives.tsx";
import { Band, Chip, Chips, Conclusion, Note, Row, Title } from "./harness.tsx";
import type { FigureDrawing, FigureProps, MotifProps } from "./types.ts";

/** What a plugin is: a descriptor that declares, a bind that contributes, and what Routecraft does with both. */
const WIDTH = 1600;
const HEIGHT = 820;

function Figure({ palette }: FigureProps) {
  return (
    <FigureCanvas palette={palette} width={WIDTH} height={HEIGHT}>
      <Band palette={palette} at={{ x: 150, y: 80, w: 790, h: 580 }}>
        <Title
          palette={palette}
          title="Your plugin"
          subtitle="a plain object that declares, then binds"
        />
        <div style={{ marginTop: 14 }}>
          <Row
            palette={palette}
            label="It declares"
            divider={false}
            labelWidth={120}
          >
            <Chips>
              <Chip
                palette={palette}
                tone="accent"
                sub="acme.approvals; the namespace is approvals"
              >
                id
              </Chip>
              <Chip
                palette={palette}
                sub="[CONTINUATIONS]; a capability, never a plugin"
              >
                requires
              </Chip>
              <Chip
                palette={palette}
                sub="[APPROVALS]; a port others may require"
              >
                provides
              </Chip>
              <Chip palette={palette} sub="a default provider it displaces">
                replaces
              </Chip>
              <Chip
                palette={palette}
                sub="[approval.decided]; moments others join"
              >
                points
              </Chip>
              <Chip palette={palette} sub="ex.approvals, typed">
                facets
              </Chip>
              <Chip palette={palette} sub=".approve() on every route builder">
                methods
              </Chip>
            </Chips>
          </Row>
          <Row palette={palette} label="bind(c)" labelWidth={120}>
            <Chips>
              {[
                "c.require(CONTINUATIONS)",
                "c.provide(APPROVALS, service)",
                "c.contribute(handler | wrapper)",
                "c.observe(event => ...)",
                "c.emit(name, data)",
                "c.onDispose(() => ...)",
              ].map((t) => (
                <Chip key={t} palette={palette}>
                  {t}
                </Chip>
              ))}
            </Chips>
            <Note palette={palette}>
              c.execution is there too: deliver, resume, sweep
            </Note>
          </Row>
          <Row palette={palette} label="Lifecycle" labelWidth={120}>
            <Chips>
              <Chip palette={palette} sub="once every route has compiled">
                start(c)
              </Chip>
              <Chip
                palette={palette}
                sub="in reverse, after what depends on it"
              >
                stop(c)
              </Chip>
            </Chips>
          </Row>
        </div>
      </Band>

      <Band palette={palette} inverse at={{ x: 960, y: 80, w: 490, h: 580 }}>
        <Title
          palette={palette}
          inverse
          title="Routecraft"
          subtitle="does the wiring"
        />
        <div style={{ marginTop: 14 }}>
          {[
            [
              "Orders",
              "by what you require and provide; a cycle or a missing provider is refused at start, by name",
            ],
            [
              "Namespaces",
              "your facet, options, events and recorded decisions live under approvals; a collision is a fault, not an overwrite",
            ],
            [
              "Freezes",
              "after the last bind; a contribution from start() would miss the composed chain, so it is refused",
            ],
            ["Starts", "in dependency order, once every route has compiled"],
            [
              "Stops",
              "in reverse, consumers before providers; every disposer runs, failures aggregated",
            ],
          ].map(([k, v], i) => (
            <Row
              key={k}
              palette={palette}
              inverse
              label={k}
              labelWidth={100}
              divider={i > 0}
            >
              <Note
                palette={palette}
                inverse
                style={{ fontSize: "0.8rem", paddingTop: 7 }}
              >
                {v}
              </Note>
            </Row>
          ))}
        </div>
      </Band>

      <Conclusion
        palette={palette}
        y={700}
        width={WIDTH}
        plain="You declare;"
        accent="Routecraft wires, orders and stops it."
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
        gap: u * 6,
      }}
    >
      <div
        style={{
          width: u * 40,
          height: u * 50,
          backgroundColor: palette.muted25,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-evenly",
          padding: `0 ${u * 6}px`,
        }}
      >
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            style={{
              height: u * 3,
              backgroundColor: i === 0 ? palette.accent : palette.muted55,
              width: `${55 + i * 10}%`,
            }}
          />
        ))}
      </div>
      <div
        style={{ width: u * 26, height: u * 50, backgroundColor: palette.fg }}
      />
    </div>
  );
}

export const pluginDeclares: FigureDrawing = {
  id: "plugin-declares",
  width: WIDTH,
  height: HEIGHT,
  Figure,
  Motif,
};
