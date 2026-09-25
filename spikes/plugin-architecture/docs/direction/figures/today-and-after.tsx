import { FigureCanvas } from "./primitives.tsx";
import {
  Band,
  Chip,
  Chips,
  Conclusion,
  Inset,
  Label,
  Note,
  Title,
} from "./harness.tsx";
import type { FigureDrawing, FigureProps, MotifProps } from "./types.ts";

/** Today against after: our features inside a block with private paths, then every feature a plugin on one kernel. */
const WIDTH = 1600;
const HEIGHT = 690;

function Figure({ palette }: FigureProps) {
  return (
    <FigureCanvas palette={palette} width={WIDTH} height={HEIGHT}>
      <Band palette={palette} at={{ x: 150, y: 80, w: 640, h: 450 }}>
        <Title
          palette={palette}
          title="Today"
          subtitle="our features are inside; yours are at the window"
        />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 14,
            marginTop: 22,
          }}
        >
          <Chips>
            <Chip palette={palette} tone="quiet">
              your plugin · apply(ctx)
            </Chip>
            <Note palette={palette}>
              one verb, the whole context, reach in and hope
            </Note>
          </Chips>
          <Inset palette={palette} inverse>
            <Label palette={palette} inverse>
              Routecraft
            </Label>
            <Chips style={{ marginTop: 10 }}>
              {[
                "routes · DSL",
                "deferral",
                "resilience",
                "auth",
                "agents",
                "stores",
                "HTTP",
              ].map((t) => (
                <Chip key={t} palette={palette}>
                  {t}
                </Chip>
              ))}
            </Chips>
            <Label
              palette={palette}
              inverse
              style={{ display: "block", marginTop: 16 }}
            >
              Private paths our own packages use
            </Label>
            <Chips style={{ marginTop: 10 }}>
              {[
                "deferAside",
                "reviveDeferral",
                "getExchangeContext",
                "markAuthentic",
              ].map((t) => (
                <Chip key={t} palette={palette}>
                  {t}
                </Chip>
              ))}
            </Chips>
          </Inset>
          <Note palette={palette}>
            dependsOn is declared on the interface and never enforced; no chain
            position, store or route method is open to you
          </Note>
        </div>
      </Band>

      <Band palette={palette} at={{ x: 810, y: 80, w: 640, h: 450 }}>
        <Title
          palette={palette}
          title="After"
          subtitle="every feature a plugin; ours and yours through the same sockets"
        />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 14,
            marginTop: 22,
          }}
        >
          <Chips>
            {["deferral", "resilience", "auth", "agents", "HTTP"].map((t) => (
              <Chip key={t} palette={palette}>
                {t}
              </Chip>
            ))}
            <Chip palette={palette} tone="accent">
              your store
            </Chip>
            <Chip palette={palette} tone="accent">
              your steps
            </Chip>
          </Chips>
          <Note palette={palette}>
            the same six sockets for every one: port, contribution, step, facet,
            point, execution
          </Note>
          <Inset palette={palette} inverse>
            <Label palette={palette} inverse accent>
              The kernel
            </Label>
            <Chips style={{ marginTop: 10 }}>
              {["lifecycle", "contracts", "the continuation protocol"].map(
                (t) => (
                  <Chip key={t} palette={palette}>
                    {t}
                  </Chip>
                ),
              )}
            </Chips>
            <Note
              palette={palette}
              inverse
              style={{ display: "block", marginTop: 12 }}
            >
              it cannot import a plugin; the dependency direction is checked
            </Note>
          </Inset>
        </div>
      </Band>

      <Conclusion
        palette={palette}
        y={570}
        width={WIDTH}
        plain="Our features move out of the room,"
        accent="and yours come in through the same door."
      />
    </FigureCanvas>
  );
}

/** Motif: a solid block beside a bar with equal posts on it. */
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
        gap: u * 8,
      }}
    >
      <div
        style={{ width: u * 30, height: u * 44, backgroundColor: palette.fg }}
      />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: u * 6,
        }}
      >
        <div style={{ display: "flex", gap: u * 4 }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              style={{
                width: u * 7,
                height: u * 22,
                border: `${Math.max(2, u * 1.4)}px solid ${i > 2 ? palette.accent : palette.muted55}`,
              }}
            />
          ))}
        </div>
        <div
          style={{ width: u * 51, height: u * 10, backgroundColor: palette.fg }}
        />
      </div>
    </div>
  );
}

export const todayAndAfter: FigureDrawing = {
  id: "today-and-after",
  width: WIDTH,
  height: HEIGHT,
  Figure,
  Motif,
};
