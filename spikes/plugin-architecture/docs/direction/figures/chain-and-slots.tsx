import { FigureCanvas } from "./primitives.tsx";
import {
  Band,
  Chip,
  Chips,
  Conclusion,
  Inset,
  Note,
  Row,
  Seq,
  Title,
} from "./harness.tsx";
import type { FigurePalette } from "./palette.ts";
import type { FigureDrawing, FigureProps, MotifProps } from "./types.ts";

/**
 * The chain around every route: positions the framework owns, slots between
 * them that any plugin adds to, and how handlers in one slot are ordered.
 */
const WIDTH = 1600;
const HEIGHT = 1040;

function Position({
  palette,
  children,
}: {
  palette: FigurePalette;
  children: string;
}) {
  return (
    <Chip palette={palette} tone="strong">
      {children}
    </Chip>
  );
}

function Slot({
  palette,
  children,
}: {
  palette: FigurePalette;
  children: string;
}) {
  return (
    <Chip palette={palette} tone="accent">
      {children}
    </Chip>
  );
}

function Figure({ palette }: FigureProps) {
  const p = (name: string) => (
    <Position key={name} palette={palette}>
      {name}
    </Position>
  );
  const s = (name: string) => (
    <Slot key={name} palette={palette}>
      {name}
    </Slot>
  );
  return (
    <FigureCanvas palette={palette} width={WIDTH} height={HEIGHT}>
      <Band palette={palette} at={{ x: 120, y: 80, w: 1360, h: 290 }}>
        <Title
          palette={palette}
          inline
          title="One chain, fixed by the framework"
          subtitle="positions hold one thing each; slots between them are where plugins add"
        />
        <div style={{ marginTop: 14 }}>
          <Row palette={palette} label="In order" divider={false}>
            <Seq
              palette={palette}
              items={[
                s("error"),
                s("beforeAuth"),
                p("authorize"),
                s("afterAuth"),
                p("parse"),
                p("input"),
                s("admitted"),
                p("throttle"),
                p("circuitBreaker"),
                p("retry"),
                s("perAttempt"),
                p("timeout"),
                p("concurrency"),
                p("cacheCheck"),
                <Chip key="steps" palette={palette}>
                  your steps
                </Chip>,
                p("cacheStore"),
                s("exit"),
              ]}
            />
          </Row>
          <Row palette={palette} label="Position">
            <Chips>
              {p("retry")}
              <Note palette={palette}>
                belongs to the framework; replace what fills it through its
                port; never move it, remove it or add one
              </Note>
            </Chips>
          </Row>
          <Row palette={palette} label="Slot">
            <Chips>
              {s("beforeAuth")}
              <Note palette={palette}>
                any number of plugins add handlers or wrappers; a handler can be
                switched off by id, a position cannot
              </Note>
            </Chips>
          </Row>
        </div>
      </Band>
      <Band palette={palette} at={{ x: 120, y: 400, w: 1360, h: 500 }}>
        <Title
          palette={palette}
          inline
          title="Inside one slot"
          subtitle="phase first, then the order the application lists its plugins"
        />
        <Inset palette={palette} inverse style={{ marginTop: 16 }}>
          <Note palette={palette} inverse style={{ fontSize: "0.82rem" }}>
            application(&#123; plugins: [security, tenancy, correlation,
            tracing, auth] &#125;)
          </Note>
        </Inset>
        <div style={{ marginTop: 6 }}>
          <Row palette={palette} label="1 · observe" divider={false}>
            <Chips>
              <Chip palette={palette}>tracing.startSpan</Chip>
              <Note palette={palette}>
                read only; order does not matter because nothing changes
              </Note>
            </Chips>
          </Row>
          <Row palette={palette} label="2 · mutate">
            <Seq
              palette={palette}
              items={[
                <Chip key="t" palette={palette} sub="writes x-tenant">
                  tenancy.setTenantFromHost
                </Chip>,
                <Chip key="c" palette={palette}>
                  correlation.addCorrelationId
                </Chip>,
              ]}
            />
            <Note palette={palette}>
              each gets the exchange the last one left; the later write to one
              field wins, and the framework warns with both names, at start when
              the field is declared in writes
            </Note>
          </Row>
          <Row palette={palette} label="3 · validate">
            <Seq
              palette={palette}
              items={[
                <Chip key="s" palette={palette}>
                  security.blockBadIps
                </Chip>,
                <Chip key="r" palette={palette} tone="strong">
                  refuse · the chain stops
                </Chip>,
              ]}
            />
            <Note palette={palette}>
              allow or refuse only; every validator sees the same final
              exchange; exit has no validate phase
            </Note>
          </Row>
          <Row palette={palette} label="Then">
            <Seq palette={palette} lead items={[p("authorize")]} />
          </Row>
          <Row palette={palette} label="Override">
            <Chips>
              <Chip palette={palette} tone="quiet">
                hooks.order[&quot;beforeAuth/mutate&quot;]
              </Chip>
              <Chip palette={palette} tone="quiet">
                hooks.disable[&quot;legacy/setTenantFromPath&quot;]
              </Chip>
              <Note palette={palette}>
                set in the application, by whoever installed both plugins
              </Note>
            </Chips>
          </Row>
        </div>
      </Band>
      <Conclusion
        palette={palette}
        y={930}
        width={WIDTH}
        plain="A plugin names a slot and a phase,"
        accent="never another plugin."
      />
    </FigureCanvas>
  );
}

function Motif({ palette, size }: MotifProps) {
  const u = size / 100;
  const cell = (fill: string, key: number) => (
    <div
      key={key}
      style={{
        width: u * 14,
        height: u * 34,
        backgroundColor: fill,
      }}
    />
  );
  return (
    <div
      style={{
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: u * 5,
      }}
    >
      {[palette.muted55, palette.accent, palette.muted55, palette.accent].map(
        cell,
      )}
    </div>
  );
}

export const chainAndSlots: FigureDrawing = {
  id: "chain-and-slots",
  width: WIDTH,
  height: HEIGHT,
  Figure,
  Motif,
};
