import type { ReactNode } from "react";

import { FigureCanvas } from "./primitives.tsx";
import {
  Band,
  Chip,
  Chips,
  Conclusion,
  Fault,
  Note,
  Row,
  Title,
} from "./harness.tsx";
import type { FigureDrawing, FigureProps, MotifProps } from "./types.ts";

/** Installation, stage by stage, with the fault each stage can refuse with. */
const WIDTH = 1600;
const HEIGHT = 870;

function Figure({ palette }: FigureProps) {
  const stage = (
    label: string,
    what: ReactNode,
    faults: readonly string[],
    strong = false,
  ) => (
    <Row
      palette={palette}
      label={label}
      labelWidth={150}
      divider={label !== "Descriptors"}
    >
      <Chips>
        <Chip palette={palette} tone={strong ? "strong" : "plain"}>
          {what}
        </Chip>
        {faults.map((f) =>
          f === f.toUpperCase() ? (
            <Fault key={f} palette={palette}>
              {f}
            </Fault>
          ) : (
            <Note key={f} palette={palette}>
              {f}
            </Note>
          ),
        )}
      </Chips>
    </Row>
  );
  return (
    <FigureCanvas palette={palette} width={WIDTH} height={HEIGHT}>
      <Band palette={palette} at={{ x: 150, y: 80, w: 1300, h: 630 }}>
        <Title
          palette={palette}
          inline
          title="Installation"
          subtitle="from descriptors to a running application; everything that can fail names the plugin responsible"
        />
        <div style={{ marginTop: 16 }}>
          {stage("Descriptors", "an ordinary array, in any order", [])}
          {stage(
            "Identity",
            "one id, one namespace, one token per port and point",
            [
              "DUPLICATE_ID",
              "DUPLICATE_NAMESPACE",
              "PORT_IDENTITY",
              "DUPLICATE_POINT",
              "INVALID_REPLACEMENT",
            ],
          )}
          {stage(
            "Resolution",
            "one provider per port, or one plus a declared replacement",
            ["MISSING_PORT", "DUPLICATE_PROVIDER"],
          )}
          {stage("Order", "a topological sort over require and provide", [
            "CYCLE",
          ])}
          {stage(
            "Bind",
            "each bind in order: require, provide, contribute, observe",
            ["UNKNOWN_POINT", "UNPROVIDED_PORT", "UNDECLARED_REQUIRE"],
          )}
          {stage("Freeze", "no contribution after this line", ["FROZEN"], true)}
          {stage(
            "Compile",
            "contributions ordered by anchor; one wrapper chain per route",
            ["ROUTE_REQUIRES", "DUPLICATE_ROUTE"],
          )}
          {stage(
            "Start",
            "sources subscribe, then each start() in order; the deferral plugin's boot scan runs here",
            ["rolled back on failure"],
          )}
          {stage(
            "Stop",
            "in reverse: consumers before providers, every failure aggregated",
            [],
          )}
        </div>
      </Band>
      <Conclusion
        palette={palette}
        y={750}
        width={WIDTH}
        plain="Nothing runs"
        accent="until every plugin is accounted for."
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
