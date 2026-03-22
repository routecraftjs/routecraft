import { render } from "ink-testing-library";
import { describe, test, expect } from "vitest";
import { CenterExchangeDetail } from "../../../src/tui/components/center-exchange-detail.js";
import { makeExchange, makeEvent } from "../../tui/fixtures.js";

describe("CenterExchangeDetail", () => {
  /**
   * @case Shows the capability (route) name in the header
   * @preconditions Exchange has routeId "my-capability"
   * @expectedResult Output contains "Capability:" and "my-capability"
   */
  test("shows Capability name in header", () => {
    const exchange = makeExchange({ routeId: "my-capability" });
    const { lastFrame } = render(
      <CenterExchangeDetail
        exchange={exchange}
        events={[]}
        width={80}
        height={30}
        scrollOffset={0}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Capability:");
    expect(frame).toContain("my-capability");
  });

  /**
   * @case Shows the exchange ID
   * @preconditions Exchange with a specific ID
   * @expectedResult Output contains "Exchange:" and the ID value
   */
  test("shows Exchange ID", () => {
    const exchange = makeExchange({ id: "ex-12345678" });
    const { lastFrame } = render(
      <CenterExchangeDetail
        exchange={exchange}
        events={[]}
        width={80}
        height={30}
        scrollOffset={0}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Exchange:");
    expect(frame).toContain("ex-12345678");
  });

  /**
   * @case Shows the exchange status
   * @preconditions Exchange with status "completed"
   * @expectedResult Output contains "Status:" and "completed"
   */
  test("shows status", () => {
    const exchange = makeExchange({ status: "completed" });
    const { lastFrame } = render(
      <CenterExchangeDetail
        exchange={exchange}
        events={[]}
        width={80}
        height={30}
        scrollOffset={0}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Status:");
    expect(frame).toContain("completed");
  });

  /**
   * @case Shows "Error:" text for failed exchanges
   * @preconditions Exchange with status "failed" and an error message
   * @expectedResult Output contains "Error:" followed by the error text
   */
  test("shows Error for failed exchanges", () => {
    const exchange = makeExchange({
      status: "failed",
      error: "Connection refused",
    });
    const { lastFrame } = render(
      <CenterExchangeDetail
        exchange={exchange}
        events={[]}
        width={80}
        height={30}
        scrollOffset={0}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Error:");
    expect(frame).toContain("Connection refused");
  });

  /**
   * @case Shows "Reason:" text for dropped exchanges
   * @preconditions Exchange with status "dropped" and a reason in the error field
   * @expectedResult Output contains "Reason:" followed by the reason text
   */
  test("shows Reason for dropped exchanges", () => {
    const exchange = makeExchange({
      status: "dropped",
      error: "Queue full",
    });
    const { lastFrame } = render(
      <CenterExchangeDetail
        exchange={exchange}
        events={[]}
        width={80}
        height={30}
        scrollOffset={0}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Reason:");
    expect(frame).toContain("Queue full");
  });

  /**
   * @case Shows events in the related events section
   * @preconditions Exchange with two related events
   * @expectedResult Output contains the "RELATED EVENTS" title and event names
   */
  test("shows events in related events section", () => {
    const exchange = makeExchange({ id: "ex-001" });
    const events = [
      makeEvent({
        id: 1,
        eventName: "exchange:started",
        details: JSON.stringify({
          routeId: "test-route",
          exchangeId: "ex-001",
        }),
      }),
      makeEvent({
        id: 2,
        eventName: "exchange:completed",
        details: JSON.stringify({
          routeId: "test-route",
          exchangeId: "ex-001",
        }),
      }),
    ];
    const { lastFrame } = render(
      <CenterExchangeDetail
        exchange={exchange}
        events={events}
        width={100}
        height={30}
        scrollOffset={0}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("RELATED EVENTS (2)");
    expect(frame).toContain("exchange:started");
    expect(frame).toContain("exchange:completed");
  });
});
